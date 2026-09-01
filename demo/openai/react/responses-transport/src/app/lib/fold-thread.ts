/**
 * Fold classified transport events into a linear thread of OpenAI messages,
 * using OpenAI's own stream accumulator (`accumulateResponse` from
 * `openai/lib/responses/ResponseAccumulator`) for the streamed assistant
 * content. The transport hands out decoded events; this fold owns everything
 * above that: demultiplexing by codec-message-id, per-message accumulation,
 * tool-call state, and run tracking.
 *
 * The accumulator is strict and index-addressed, so the fold owns four pieces
 * of bookkeeping the wire deliberately leaves to the consumer:
 *
 * 1. **Seeding.** With no snapshot the accumulator accepts only a
 *    `response.created` event, which the codec keeps off the wire. Each
 *    per-message fold therefore seeds a minimal synthetic `Response` snapshot
 *    (`{ object: 'response', output: [], ... }`) — the accumulator's
 *    mutations only ever touch `output` and `output_text`.
 * 2. **Output-index bookkeeping.** The accumulator addresses items by
 *    `output_index`, but the wire drops it from the discrete item envelopes
 *    and the rebuilt deltas carry only `item_id`. The fold keeps its own
 *    item-id → index map and stamps every accumulated event's `output_index`
 *    from it, so an event always addresses the slot its item actually
 *    occupies in this fold's snapshot.
 * 3. **Duplicate openers.** The decoder synthesises `response.output_item.added`
 *    on a mid-stream join and rebuilds a part opener per stream, so a fold that
 *    combines history with a live continuation sees the same item and part
 *    opened twice. The accumulator's `added` cases append unconditionally, so
 *    the fold collapses them: an `output_item.added` for a known item id is
 *    skipped, and a part opener whose slot already exists is skipped.
 * 4. **Reduced done items.** The wire's `response.output_item.done` carries a
 *    REDUCED item — status plus the residue the deltas cannot rebuild
 *    (per-part `logprobs`, a reasoning item's `encrypted_content`) — while the
 *    accumulator's `done` case REPLACES the accumulated item wholesale, which
 *    would erase the streamed content. The fold merges those fields onto the
 *    accumulated item instead of handing the event to the accumulator.
 *
 * The codec's two non-OpenAI output events (`function_call_output`,
 * `tool-approval-request`) and the client input bodies (`message`, `item`,
 * `approval`) apply as small steps onto the per-message items and
 * `toolCallStates`. A `message` input arrives whole on the optimistic local
 * echo and part-by-part on the wire echo, so its content parts merge with
 * identical parts deduplicated.
 */

import type { RunStatus, TransportEvent, WireMeta } from '@ably/ai-transport';
import type {
  OpenAIInput,
  OpenAIItem,
  OpenAIMessage,
  OpenAIOutput,
  OpenAIToolCallState,
} from '@ably/ai-transport/openai';
import { accumulateResponse } from 'openai/lib/responses/ResponseAccumulator';
import type { Responses } from 'openai/resources/responses/responses';

/** One folded message of the thread: an {@link OpenAIMessage} plus its wire identity. */
export interface ThreadMessage extends OpenAIMessage {
  /** The codec-message-id every event of this message shares. */
  codecMessageId: string;
  /** The run this message was published under, when the wire carried one. */
  runId?: string;
  /** The Ably clientId of the message's publisher, when known. */
  clientId?: string;
}

/** The folded view of one run, derived from its lifecycle events. */
export interface RunSummary {
  /** The run's lifecycle status. */
  status: RunStatus;
  /** The terminal error message, present when the run ended in error. */
  errorMessage?: string;
  /** The codec-message-id of the input that triggered the run, when stamped on run-start. */
  inputCodecMessageId?: string;
}

/**
 * A stateful fold over {@link TransportEvent}s. `apply` events in chronological
 * order (hydrated history first, then live); read the derived thread and run
 * state between applications.
 */
export interface ThreadFold {
  /** Fold one classified transport event into the thread. Throws when an event addresses an item the fold has never seen — a decode-sequence bug worth surfacing, not hiding. */
  apply(event: TransportEvent<OpenAIInput, OpenAIOutput>): void;
  /** The thread's messages, in first-seen codec-message-id order. */
  messages(): ThreadMessage[];
  /** Every observed run's folded state, keyed by run-id, in first-seen order. */
  runs(): ReadonlyMap<string, RunSummary>;
  /** The run with the most recent lifecycle activity, or undefined before any run event. */
  activeRunId(): string | undefined;
  /** Whether the most recently active run is streaming (its latest lifecycle event is start/resume). */
  isRunning(): boolean;
}

/** The output item types this fold stores — the set the codec models. */
type ModelledItem = Extract<Responses.ResponseOutputItem, { type: 'message' | 'reasoning' | 'function_call' }>;

const isModelledItem = (item: Responses.ResponseOutputItem): item is ModelledItem =>
  item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call';

/**
 * The minimal synthetic snapshot the accumulator's mutations need: it only
 * ever touches `output` and `output_text`. The remaining fields exist to
 * satisfy the `Response` type; nothing reads them.
 */
const seedSnapshot = (id: string): Responses.Response => ({
  id,
  object: 'response',
  created_at: 0,
  output: [],
  output_text: '',
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: '',
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: 'auto',
  tools: [],
  top_p: null,
});

/** The per-message fold state. */
interface MessageFold {
  codecMessageId: string;
  role: 'user' | 'assistant';
  runId?: string;
  clientId?: string;
  /** The accumulator target for the message's streamed output. */
  snapshot: Responses.Response;
  /** item id → index in `snapshot.output`, the fold's own output addressing. */
  indexByItemId: Map<string, number>;
  /** Items applied outside the accumulator: tool outputs and user input items. */
  appended: OpenAIItem[];
  /** Out-of-band per-call state (approval decisions), keyed by call_id. */
  toolCallStates: Record<string, OpenAIToolCallState>;
}

/**
 * Recursively sort object keys so two values that differ only in key order
 * serialise the same. The optimistic local echo is the caller's own object,
 * while the wire echo comes back from the codec's decode with its fields in
 * the decoder's order — a plain `JSON.stringify` comparison reads those as two
 * different parts and the sender sees their own text twice.
 * @param value - The value to canonicalise.
 * @returns The value with every nested object's keys in sorted order.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    // CAST: `value` is a non-null object, so indexing it by its own key is safe.
    sorted[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

/** Structural-equality check for merged input items and content parts, key order aside. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Whether an item is a client-published input message (a user turn's item), as
 * opposed to the assistant's streamed output message — both carry
 * `type: 'message'`, but only the output message's role is `'assistant'`.
 */
const isInputMessageItem = (item: OpenAIItem): item is Responses.ResponseInputItem.Message =>
  item.type === 'message' && item.role !== 'assistant';

/** Append a `function_call_output` item unless one for its call is already present. */
const appendFunctionCallOutput = (fold: MessageFold, item: Responses.ResponseInputItem.FunctionCallOutput): void => {
  const exists = fold.appended.some((it) => it.type === 'function_call_output' && it.call_id === item.call_id);
  if (!exists) fold.appended.push(item);
};

/**
 * Merge a `message`-kind input body into the fold. The optimistic local echo
 * carries the whole turn; each wire echo carries one content part under the
 * same codec-message-id. Message items merge into one item per fold with
 * identical parts deduplicated; any other item type appends with a whole-item
 * dedupe.
 */
const mergeTurn = (fold: MessageFold, payload: OpenAIMessage): void => {
  for (const item of payload.items) {
    if (!isInputMessageItem(item)) {
      if (!fold.appended.some((it) => sameJson(it, item))) fold.appended.push(item);
      continue;
    }
    const existing = fold.appended.find(isInputMessageItem);
    if (!existing) {
      // Clone so later part merges never mutate the caller's payload.
      fold.appended.push({ ...item, content: [...item.content] });
      continue;
    }
    for (const part of item.content) {
      if (!existing.content.some((p) => sameJson(p, part))) existing.content.push(part);
    }
  }
};

/** Apply one decoded client input body. */
const applyInput = (fold: MessageFold, input: OpenAIInput): void => {
  switch (input.kind) {
    case 'message': {
      mergeTurn(fold, input.payload);
      break;
    }
    case 'item': {
      appendFunctionCallOutput(fold, input.payload);
      break;
    }
    case 'approval': {
      const { call_id, approved, reason } = input.payload;
      fold.toolCallStates[call_id] = {
        ...fold.toolCallStates[call_id],
        approval: approved ? 'approved' : 'denied',
        ...(reason !== undefined && { reason }),
      };
      break;
    }
    case 'regenerate': {
      // This linear demo never publishes it; a foreign one folds to nothing.
      break;
    }
  }
};

/**
 * Merge a reduced `response.output_item.done` onto the accumulated item: the
 * terminal status, a message part's `logprobs` residue (index-aligned), and a
 * reasoning item's `encrypted_content`. Replaying the reduced item through the
 * accumulator would replace the accumulated rich item and lose its content.
 */
const mergeDoneItem = (
  fold: MessageFold,
  done: Extract<OpenAIOutput, { type: 'response.output_item.done' }>['item'],
): void => {
  const doneId = 'id' in done ? done.id : undefined;
  const index = doneId === undefined ? undefined : fold.indexByItemId.get(doneId);
  const target = index === undefined ? undefined : fold.snapshot.output[index];
  // Without an accumulated item there is nothing to finalise; the reduced done
  // carries no content to build one from.
  if (!target || target.type !== done.type) return;

  if (target.type === 'message' && done.type === 'message') {
    target.status = done.status;
    for (const [i, residue] of (done.content ?? []).entries()) {
      const slot = target.content[i];
      if (residue.type === 'output_text' && residue.logprobs !== undefined && slot?.type === 'output_text') {
        slot.logprobs = residue.logprobs;
      }
    }
  } else if (target.type === 'function_call' && done.type === 'function_call') {
    if (done.status !== undefined) target.status = done.status;
  } else if (target.type === 'reasoning' && done.type === 'reasoning') {
    if (done.status !== undefined) target.status = done.status;
    if (typeof done.encrypted_content === 'string') target.encrypted_content = done.encrypted_content;
  }
};

/** Whether a part opener's slot already exists on the accumulated item (a duplicate opener from a mid-stream join). */
const partSlotExists = (target: Responses.ResponseOutputItem | undefined, event: OpenAIOutput): boolean => {
  if (event.type === 'response.content_part.added') {
    if (target?.type === 'message') return target.content.length > event.content_index;
    if (target?.type === 'reasoning') return (target.content?.length ?? 0) > event.content_index;
  }
  if (event.type === 'response.reasoning_summary_part.added' && target?.type === 'reasoning') {
    return target.summary.length > event.summary_index;
  }
  return false;
};

/** Apply one decoded agent output event. */
const applyOutput = (fold: MessageFold, event: OpenAIOutput): void => {
  if (event.type === 'function_call_output') {
    appendFunctionCallOutput(fold, event.item);
    return;
  }

  if (event.type === 'tool-approval-request') {
    const state = fold.toolCallStates[event.call_id];
    fold.toolCallStates[event.call_id] = {
      ...state,
      // A decision that already folded (a hydrated approval) wins over the
      // request's pending marker.
      approval: state?.approval ?? 'pending',
      name: event.name,
      arguments: event.arguments,
    };
    return;
  }

  if (event.type === 'response.output_item.added') {
    // Find-or-create on the item id: the decoder synthesises this opener on
    // mid-stream joins, so a fold combining history and live sees it twice.
    const itemId = event.item.id;
    if (itemId !== undefined && fold.indexByItemId.has(itemId)) return;
    // CAST: the decoded wire event omits `sequence_number`, which the
    // accumulator never reads.
    fold.snapshot = accumulateResponse(event as Responses.ResponseStreamEvent, fold.snapshot);
    if (itemId !== undefined) fold.indexByItemId.set(itemId, fold.snapshot.output.length - 1);
    return;
  }

  if (event.type === 'response.output_item.done') {
    mergeDoneItem(fold, event.item);
    return;
  }

  // Every remaining decoded output is a stream event addressing its item by
  // the re-stamped `item_id`; re-derive `output_index` from this fold's own
  // map so the accumulator addresses the slot the item occupies here.
  const itemId = 'item_id' in event ? event.item_id : undefined;
  const index = itemId === undefined ? undefined : fold.indexByItemId.get(itemId);
  if (index === undefined) {
    // The decoder's contract synthesises the opening bracket ahead of any
    // stream event, so an unknown item is a decode-sequence bug: fail loudly
    // with the event attached rather than dropping content.
    throw new Error(
      `unable to fold output event; no accumulated item for item_id ${String(itemId)}: ${JSON.stringify(event)}`,
    );
  }
  if (partSlotExists(fold.snapshot.output[index], event)) return;
  // CAST: the decoded wire events omit fields the accumulator never reads
  // (`sequence_number`; `output_text.done`'s logprobs), and `output_index` is
  // re-derived locally because the wire does not carry it on every event.
  fold.snapshot = accumulateResponse({ ...event, output_index: index } as Responses.ResponseStreamEvent, fold.snapshot);
};

/** Resolve a bucket's role from the decoded inputs, the wire role header, or the event direction. */
const roleOf = (meta: WireMeta, inputs: OpenAIInput[], outputs: OpenAIOutput[]): 'user' | 'assistant' => {
  for (const input of inputs) {
    if (input.kind === 'message') return input.payload.role;
  }
  if (meta.role === 'user' || meta.role === 'assistant') return meta.role;
  return outputs.length > 0 ? 'assistant' : 'user';
};

/**
 * Create a {@link ThreadFold}. One fold instance folds one channel's events;
 * create a fresh one to re-hydrate from scratch.
 */
export const createThreadFold = (): ThreadFold => {
  const folds: MessageFold[] = [];
  const foldById = new Map<string, MessageFold>();
  const runOrder: string[] = [];
  const runById = new Map<string, RunSummary>();
  let lastRunId: string | undefined;

  const applyMessage = (event: Extract<TransportEvent<OpenAIInput, OpenAIOutput>, { kind: 'message' }>): void => {
    const { meta, inputs, outputs } = event;
    const codecMessageId = meta.codecMessageId;
    if (codecMessageId === undefined) return;
    if (inputs.length === 0 && outputs.length === 0) return;

    let fold = foldById.get(codecMessageId);
    if (!fold) {
      fold = {
        codecMessageId,
        role: roleOf(meta, inputs, outputs),
        snapshot: seedSnapshot(codecMessageId),
        indexByItemId: new Map(),
        appended: [],
        toolCallStates: {},
      };
      foldById.set(codecMessageId, fold);
      folds.push(fold);
    }
    if (fold.runId === undefined && meta.runId !== undefined) fold.runId = meta.runId;
    if (fold.clientId === undefined && meta.clientId !== undefined) fold.clientId = meta.clientId;

    for (const input of inputs) applyInput(fold, input);
    for (const output of outputs) applyOutput(fold, output);
  };

  const applyRunLifecycle = (
    event: Extract<TransportEvent<OpenAIInput, OpenAIOutput>, { kind: 'run-lifecycle' }>['event'],
  ): void => {
    const existing = runById.get(event.runId);
    if (!existing) runOrder.push(event.runId);
    let summary: RunSummary;
    switch (event.type) {
      case 'start': {
        summary = {
          status: 'active',
          ...(event.inputCodecMessageId !== undefined && { inputCodecMessageId: event.inputCodecMessageId }),
        };
        break;
      }
      case 'resume': {
        summary = { ...existing, status: 'active' };
        break;
      }
      case 'suspend': {
        summary = { ...existing, status: 'suspended' };
        break;
      }
      case 'end': {
        summary = {
          ...existing,
          status: event.reason,
          ...(event.reason === 'error' && { errorMessage: event.error.message }),
        };
        break;
      }
    }
    runById.set(event.runId, summary);
    lastRunId = event.runId;
  };

  return {
    apply(event) {
      if (event.kind === 'message') applyMessage(event);
      else if (event.kind === 'run-lifecycle') applyRunLifecycle(event.event);
      // step-lifecycle events carry retry bookkeeping this demo's agent never
      // produces (each pipe is a single attempt), so they fold to nothing.
    },
    messages() {
      const out: ThreadMessage[] = [];
      for (const fold of folds) {
        const items: OpenAIItem[] = [...fold.snapshot.output.filter(isModelledItem), ...fold.appended];
        const hasStates = Object.keys(fold.toolCallStates).length > 0;
        if (items.length === 0 && !hasStates) continue;
        out.push({
          codecMessageId: fold.codecMessageId,
          role: fold.role,
          items,
          ...(hasStates && { toolCallStates: fold.toolCallStates }),
          ...(fold.runId !== undefined && { runId: fold.runId }),
          ...(fold.clientId !== undefined && { clientId: fold.clientId }),
        });
      }
      return out;
    },
    runs() {
      const out = new Map<string, RunSummary>();
      for (const runId of runOrder) {
        const summary = runById.get(runId);
        if (summary) out.set(runId, summary);
      }
      return out;
    },
    activeRunId() {
      return lastRunId;
    },
    isRunning() {
      if (lastRunId === undefined) return false;
      return runById.get(lastRunId)?.status === 'active';
    },
  };
};
