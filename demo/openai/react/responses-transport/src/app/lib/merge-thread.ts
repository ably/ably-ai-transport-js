/**
 * Merge classified transport events into a linear thread of OpenAI messages,
 * using OpenAI's own stream accumulator (`accumulateResponse` from
 * `openai/lib/responses/ResponseAccumulator`) for the streamed assistant
 * content. The transport hands out decoded events; this merge owns everything
 * above that: demultiplexing by transport-message-id, per-message accumulation,
 * tool-call state, and run tracking.
 *
 * The accumulator is strict and index-addressed, so the merge owns four pieces
 * of bookkeeping the wire deliberately leaves to the consumer:
 *
 * 1. **Seeding.** With no snapshot the accumulator accepts only a
 *    `response.created` event, which the codec keeps off the wire. Each
 *    per-message merge therefore seeds a minimal synthetic `Response` snapshot
 *    (`{ object: 'response', output: [], ... }`) — the accumulator's
 *    mutations only ever touch `output` and `output_text`.
 * 2. **Output-index bookkeeping.** The accumulator addresses items by
 *    `output_index`, but the wire drops it from the discrete item envelopes
 *    and the rebuilt deltas carry only `item_id`. The merge keeps its own
 *    item-id → index map and stamps every accumulated event's `output_index`
 *    from it, so an event always addresses the slot its item actually
 *    occupies in this merge's snapshot.
 * 3. **Duplicate openers.** The decoder synthesises `response.output_item.added`
 *    on a mid-stream join and rebuilds a part opener per stream, so a merge that
 *    combines history with a live continuation sees the same item and part
 *    opened twice. The accumulator's `added` cases append unconditionally, so
 *    the merge collapses them: an `output_item.added` for a known item id is
 *    skipped, and a part opener whose slot already exists is skipped.
 * 4. **Reduced done items.** The wire's `response.output_item.done` carries a
 *    REDUCED item — status plus the residue the deltas cannot rebuild
 *    (per-part `logprobs`, a reasoning item's `encrypted_content`) — while the
 *    accumulator's `done` case REPLACES the accumulated item wholesale, which
 *    would erase the streamed content. The merge applies those fields onto the
 *    accumulated item instead of handing the event to the accumulator.
 *
 * The codec's two non-OpenAI output events (`function_call_output`,
 * `tool-approval-request`) and the client input bodies (`message`, `item`,
 * `approval`) apply as small steps onto the per-message items and
 * `toolCallStates`. A `message` input arrives whole — the passthrough codec
 * publishes the body as one discrete `ai-input` — so the merge exists for
 * redelivery, merging a repeated body into the message it already
 * contributed to rather than duplicating its parts.
 */

import type { RunStatus, TransportEvent, WireMeta } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
import { accumulateResponse } from 'openai/lib/responses/ResponseAccumulator';
import type { Responses } from 'openai/resources/responses/responses';

import {
  asOpenAIInput,
  type OpenAIInput,
  type OpenAIItem,
  type OpenAIMessage,
  type OpenAIToolCallState,
} from './openai-thread';

/** One merged message of the thread: an {@link OpenAIMessage} plus its wire identity. */
export interface ThreadMessage extends OpenAIMessage {
  /** The transport-message-id every event of this message shares. */
  transportMessageId: string;
  /** The run this message was published under, when the wire carried one. */
  runId?: string;
  /** The Ably clientId of the message's publisher, when known. */
  clientId?: string;
}

/** The merged view of one run, derived from its lifecycle events. */
export interface RunSummary {
  /** The run's lifecycle status. */
  status: RunStatus;
  /** The terminal error message, present when the run ended in error. */
  errorMessage?: string;
  /** The transport-message-id of the input that triggered the run, when stamped on run-start. */
  inputTransportMessageId?: string;
}

/**
 * A merged thread as a store holds it — what {@link ThreadMerge.seed} takes
 * and what {@link ThreadMerge.messages} and {@link ThreadMerge.runs} produce.
 */
export interface ThreadSnapshot {
  /** The merged messages, oldest first. */
  messages: ThreadMessage[];
  /** Every run's merged state, in first-seen order, as `[runId, summary]` pairs. */
  runs: [string, RunSummary][];
}

/**
 * A stateful merge over {@link TransportEvent}s. `apply` events in chronological
 * order (hydrated history first, then live); read the derived thread and run
 * state between applications.
 */
export interface ThreadMerge {
  /**
   * Adopt an already-merged thread as this merge's starting state, so events
   * applied afterwards continue it rather than rebuild it. This is how a
   * client hydrates from a store of finished messages: the store holds the
   * merged result, and only what happened since needs merging.
   *
   * Call it once, before any {@link apply}. Every stored message becomes an
   * addressable bucket again — its output items keep their ids, so a later
   * delta or a tool resolution lands on the message it belongs to.
   * @param state - The stored thread: its messages (oldest first) and its runs (in first-seen order).
   */
  seed(state: ThreadSnapshot): void;
  /** Merge one classified transport event into the thread. Decoded inputs are passthrough JSON and narrow to the demo's union at this boundary (an unrecognised body is skipped). Throws when an event addresses an item the merge has never seen — a decode-sequence bug worth surfacing, not hiding. */
  apply(event: TransportEvent<OpenAIInput, OpenAIOutput>): void;
  /** The thread's messages, in first-seen transport-message-id order. */
  messages(): ThreadMessage[];
  /** Every observed run's merged state, keyed by run-id, in first-seen order. */
  runs(): ReadonlyMap<string, RunSummary>;
  /** The run with the most recent lifecycle activity, or undefined before any run event. */
  activeRunId(): string | undefined;
  /** Whether the most recently active run is streaming (its latest lifecycle event is start/resume). */
  isRunning(): boolean;
}

/** The output item types this merge stores — the set the codec models. */
type ModelledItem = Extract<Responses.ResponseOutputItem, { type: 'message' | 'reasoning' | 'function_call' }>;

const isModelledItem = (item: Responses.ResponseOutputItem): item is ModelledItem =>
  item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call';

/**
 * Whether a stored item belongs in the accumulator's snapshot rather than the
 * out-of-band `appended` list. Only an assistant output item with an id does:
 * the id is how a later delta addresses it, and `messages()` reads the
 * snapshot through {@link isModelledItem}, which a user turn's input message
 * and a `function_call_output` both fail.
 * @param item - The stored item.
 * @returns Whether it is an addressable output item, narrowing its id to present.
 */
const isSeedableOutputItem = (item: OpenAIItem): item is ModelledItem & { id: string } => {
  if (item.type === 'reasoning' || item.type === 'function_call') return 'id' in item && item.id !== undefined;
  if (item.type !== 'message') return false;
  return 'id' in item && item.id !== undefined && item.role === 'assistant';
};

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

/** The per-message merge state. */
interface MessageMerge {
  transportMessageId: string;
  role: 'user' | 'assistant';
  runId?: string;
  clientId?: string;
  /** The accumulator target for the message's streamed output. */
  snapshot: Responses.Response;
  /** item id → index in `snapshot.output`, the merge's own output addressing. */
  indexByItemId: Map<string, number>;
  /** Items applied outside the accumulator: tool outputs and user input items. */
  appended: OpenAIItem[];
  /** Out-of-band per-call state (approval decisions), keyed by call_id. */
  toolCallStates: Record<string, OpenAIToolCallState>;
}

/**
 * Recursively sort object keys so two values that differ only in key order
 * serialise the same. A redelivered wire event comes back through the codec's
 * decode with its fields in the decoder's order, which need not match the
 * order the publisher wrote them in — a plain `JSON.stringify` comparison
 * reads those as two different parts and the text appears twice.
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
const appendFunctionCallOutput = (merge: MessageMerge, item: Responses.ResponseInputItem.FunctionCallOutput): void => {
  const exists = merge.appended.some((it) => it.type === 'function_call_output' && it.call_id === item.call_id);
  if (!exists) merge.appended.push(item);
};

/**
 * Merge a `message`-kind input body into one message's bucket. The body
 * arrives whole on one wire event; message items merge into a single item per
 * bucket with identical parts deduplicated, so a redelivery of the same body
 * adds nothing. Any other item type appends with a whole-item dedupe.
 * @param bucket - The per-message accumulator to merge into.
 * @param payload - The message body the wire carried.
 */
const mergeTurn = (bucket: MessageMerge, payload: OpenAIMessage): void => {
  for (const item of payload.items) {
    if (!isInputMessageItem(item)) {
      if (!bucket.appended.some((it) => sameJson(it, item))) bucket.appended.push(item);
      continue;
    }
    const existing = bucket.appended.find(isInputMessageItem);
    if (!existing) {
      // Clone so later part merges never mutate the caller's payload.
      bucket.appended.push({ ...item, content: [...item.content] });
      continue;
    }
    for (const part of item.content) {
      if (!existing.content.some((p) => sameJson(p, part))) existing.content.push(part);
    }
  }
};

/** Apply one decoded client input body. */
const applyInput = (merge: MessageMerge, input: OpenAIInput): void => {
  switch (input.kind) {
    case 'message': {
      mergeTurn(merge, input.payload);
      break;
    }
    case 'item': {
      appendFunctionCallOutput(merge, input.payload);
      break;
    }
    case 'approval': {
      const { call_id, approved, reason } = input.payload;
      merge.toolCallStates[call_id] = {
        ...merge.toolCallStates[call_id],
        approval: approved ? 'approved' : 'denied',
        ...(reason !== undefined && { reason }),
      };
      break;
    }
    case 'regenerate': {
      // This linear demo never publishes one; a foreign publisher's
      // contributes nothing to the thread.
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
  merge: MessageMerge,
  done: Extract<OpenAIOutput, { type: 'response.output_item.done' }>['item'],
): void => {
  const doneId = 'id' in done ? done.id : undefined;
  const index = doneId === undefined ? undefined : merge.indexByItemId.get(doneId);
  const target = index === undefined ? undefined : merge.snapshot.output[index];
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
const applyOutput = (merge: MessageMerge, event: OpenAIOutput): void => {
  if (event.type === 'function_call_output') {
    appendFunctionCallOutput(merge, event.item);
    return;
  }

  if (event.type === 'tool-approval-request') {
    const state = merge.toolCallStates[event.call_id];
    merge.toolCallStates[event.call_id] = {
      ...state,
      // A decision that already merged (a hydrated approval) wins over the
      // request's pending marker.
      approval: state?.approval ?? 'pending',
      name: event.name,
      arguments: event.arguments,
    };
    return;
  }

  if (event.type === 'response.output_item.added') {
    // Find-or-create on the item id: the decoder synthesises this opener on
    // mid-stream joins, so a merge combining history and live sees it twice.
    const itemId = event.item.id;
    if (itemId !== undefined && merge.indexByItemId.has(itemId)) return;
    // CAST: the decoded wire event omits `sequence_number`, which the
    // accumulator never reads.
    merge.snapshot = accumulateResponse(event as Responses.ResponseStreamEvent, merge.snapshot);
    if (itemId !== undefined) merge.indexByItemId.set(itemId, merge.snapshot.output.length - 1);
    return;
  }

  if (event.type === 'response.output_item.done') {
    mergeDoneItem(merge, event.item);
    return;
  }

  // Every remaining decoded output is a stream event addressing its item by
  // the re-stamped `item_id`; re-derive `output_index` from this merge's own
  // map so the accumulator addresses the slot the item occupies here.
  const itemId = 'item_id' in event ? event.item_id : undefined;
  const index = itemId === undefined ? undefined : merge.indexByItemId.get(itemId);
  if (index === undefined) {
    // The decoder's contract synthesises the opening bracket ahead of any
    // stream event, so an unknown item is a decode-sequence bug: fail loudly
    // with the event attached rather than dropping content.
    throw new Error(
      `unable to merge output event; no accumulated item for item_id ${String(itemId)}: ${JSON.stringify(event)}`,
    );
  }
  if (partSlotExists(merge.snapshot.output[index], event)) return;
  // CAST: the decoded wire events omit fields the accumulator never reads
  // (`sequence_number`; `output_text.done`'s logprobs), and `output_index` is
  // re-derived locally because the wire does not carry it on every event.
  merge.snapshot = accumulateResponse(
    { ...event, output_index: index } as Responses.ResponseStreamEvent,
    merge.snapshot,
  );
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
 * Create a {@link ThreadMerge}. One merge instance takes one channel's events;
 * create a fresh one to re-hydrate from scratch.
 */
export const createThreadMerge = (): ThreadMerge => {
  const merges: MessageMerge[] = [];
  const mergeById = new Map<string, MessageMerge>();
  const runOrder: string[] = [];
  const runById = new Map<string, RunSummary>();
  let lastRunId: string | undefined;

  const applyMessage = (event: Extract<TransportEvent<OpenAIInput, OpenAIOutput>, { kind: 'message' }>): void => {
    const { meta, outputs } = event;
    // The narrowing boundary: decoded inputs are passthrough JSON; keep the
    // bodies in this demo's vocabulary and skip anything else (another app's
    // body on a shared channel).
    const inputs = event.inputs.map(asOpenAIInput).filter((input) => input !== undefined);
    const transportMessageId = meta.transportMessageId;
    if (transportMessageId === undefined) return;
    if (inputs.length === 0 && outputs.length === 0) return;

    let merge = mergeById.get(transportMessageId);
    if (!merge) {
      merge = {
        transportMessageId,
        role: roleOf(meta, inputs, outputs),
        snapshot: seedSnapshot(transportMessageId),
        indexByItemId: new Map(),
        appended: [],
        toolCallStates: {},
      };
      mergeById.set(transportMessageId, merge);
      merges.push(merge);
    }
    if (merge.runId === undefined && meta.runId !== undefined) merge.runId = meta.runId;
    if (merge.clientId === undefined && meta.clientId !== undefined) merge.clientId = meta.clientId;

    for (const input of inputs) applyInput(merge, input);
    for (const output of outputs) applyOutput(merge, output);
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
          ...(event.inputTransportMessageId !== undefined && {
            inputTransportMessageId: event.inputTransportMessageId,
          }),
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
    seed(state) {
      for (const message of state.messages) {
        const snapshot = seedSnapshot(message.transportMessageId);
        const indexByItemId = new Map<string, number>();
        const appended: OpenAIItem[] = [];
        for (const item of message.items) {
          if (isSeedableOutputItem(item)) {
            indexByItemId.set(item.id, snapshot.output.length);
            snapshot.output.push(item);
            continue;
          }
          appended.push(item);
        }
        const merge: MessageMerge = {
          transportMessageId: message.transportMessageId,
          role: message.role,
          snapshot,
          indexByItemId,
          appended,
          toolCallStates: { ...message.toolCallStates },
          ...(message.runId !== undefined && { runId: message.runId }),
          ...(message.clientId !== undefined && { clientId: message.clientId }),
        };
        mergeById.set(message.transportMessageId, merge);
        merges.push(merge);
      }
      for (const [runId, summary] of state.runs) {
        if (!runById.has(runId)) runOrder.push(runId);
        runById.set(runId, summary);
        lastRunId = runId;
      }
    },
    apply(event) {
      if (event.kind === 'message') applyMessage(event);
      else if (event.kind === 'run-lifecycle') applyRunLifecycle(event.event);
      // step-lifecycle events carry retry bookkeeping this demo's agent never
      // produces (each pipe is a single attempt), so they merge to nothing.
    },
    messages() {
      const out: ThreadMessage[] = [];
      for (const merge of merges) {
        const items: OpenAIItem[] = [...merge.snapshot.output.filter(isModelledItem), ...merge.appended];
        const hasStates = Object.keys(merge.toolCallStates).length > 0;
        if (items.length === 0 && !hasStates) continue;
        out.push({
          transportMessageId: merge.transportMessageId,
          role: merge.role,
          items,
          ...(hasStates && { toolCallStates: merge.toolCallStates }),
          ...(merge.runId !== undefined && { runId: merge.runId }),
          ...(merge.clientId !== undefined && { clientId: merge.clientId }),
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
