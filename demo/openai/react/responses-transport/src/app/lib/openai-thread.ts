/**
 * The demo's OpenAI conversation model — its input vocabulary, its stored
 * message shape, the model-input flatten, and the agent loop's correlation
 * readers.
 *
 * The SDK's OpenAI codec carries inputs as opaque passthrough JSON
 * (`WireCodec<unknown, OpenAIOutput>`), so the application owns this
 * vocabulary: what a turn body, a tool resolution, and an approval decision
 * look like, and how a merge renders them. Everything here stays in OpenAI's
 * own item vocabulary wherever one exists, so a stored conversation is valid
 * `/responses` input as-is.
 */

import type { Responses } from 'openai/resources/responses/responses';
import { isModelledOutputItem, type ModelledOutputItem } from '@ably/ai-transport/openai';

// ---------------------------------------------------------------------------
// Stored message model
// ---------------------------------------------------------------------------

/**
 * The out-of-band state of one tool call, keyed by `call_id` and surfaced on
 * {@link OpenAIMessage.toolCallStates}. OpenAI's item model can express
 * neither a plain-function approval decision nor a "failed" result, so both
 * are held here rather than in a message's `items` — keeping every stored
 * {@link OpenAIItem} a valid `ResponseInputItem`.
 */
export interface OpenAIToolCallState {
  /** The gated call's approval status, set once the agent requests approval and updated by the client's response. */
  approval?: 'pending' | 'approved' | 'denied';
  /** The client-side execution result status, recorded by the merge since a `function_call_output` item cannot carry a failure status. */
  result?: 'ok' | 'failed';
  /** The tool name, carried on the approval request so a client can render the prompt without the streamed `function_call`. */
  name?: string;
  /** The tool arguments as JSON text, carried on the approval request. */
  arguments?: string;
  /** Optional human-readable reason accompanying an approval decision (typically a denial). */
  reason?: string;
}

/**
 * A single item within a message — every shape a stored message can hold. All
 * are members of `ResponseInputItem`, so a message is valid `/responses`
 * input as-is, with no conversion (see {@link toResponsesInput}).
 */
export type OpenAIItem =
  | ModelledOutputItem
  | Responses.ResponseInputItem.FunctionCallOutput
  | Responses.ResponseInputItem.Message;

/**
 * One message's worth of OpenAI items, tagged with the message's role — the
 * shape the merge renders and a turn body carries. An assistant message can
 * hold several output items; a user message holds a single input message item
 * (whose multiplicity lives in its content parts).
 */
export interface OpenAIMessage {
  /** Whether this message is the user's prompt or the assistant's reply. */
  role: 'user' | 'assistant';
  /** The message's items, in wire order. */
  items: OpenAIItem[];
  /** Out-of-band tool-call state, keyed by `call_id`; see {@link OpenAIToolCallState}. */
  toolCallStates?: Record<string, OpenAIToolCallState>;
}

// ---------------------------------------------------------------------------
// Input vocabulary (published as passthrough JSON)
// ---------------------------------------------------------------------------

/**
 * The approval decision for a tool the agent gated behind a
 * `tool-approval-request` output event. The Responses API has no item for a
 * client-side approval decision, so the demo defines the body; a denial is
 * typically followed by a `function_call_output` recording it, so the
 * `/responses` round-trip has no dangling `function_call`.
 */
export interface OpenAIApprovalDecision {
  /** The `call_id` of the gated `function_call`. */
  call_id: string;
  /** Whether the user approved the tool execution. */
  approved: boolean;
  /** Optional human-readable reason, typically supplied on denial. */
  reason?: string;
}

/** A new conversation turn: the body is an {@link OpenAIMessage}. */
export interface OpenAIMessageInput {
  /** Discriminator. */
  kind: 'message';
  /** The turn's message: a role plus its `ResponseInputItem` list. */
  payload: OpenAIMessage;
}

/** A regeneration signal. Carries no body: the structure rides the transport's publish options. */
export interface OpenAIRegenerateInput {
  /** Discriminator. */
  kind: 'regenerate';
}

/**
 * A tool resolution: OpenAI's own `function_call_output` item, published
 * against the assistant message holding the `function_call` (addressed by the
 * publish options' `codecMessageId`).
 */
export interface OpenAIItemInput {
  /** Discriminator. */
  kind: 'item';
  /** The `function_call_output` item, in OpenAI's own item vocabulary. */
  payload: Responses.ResponseInputItem.FunctionCallOutput;
}

/** A tool-approval decision, published against the assistant message whose call it gates. */
export interface OpenAIApprovalInput {
  /** Discriminator. */
  kind: 'approval';
  /** The approval decision. */
  payload: OpenAIApprovalDecision;
}

/**
 * Every body this demo publishes on the `ai-input` wire. The codec carries
 * these opaquely; {@link asOpenAIInput} narrows a decoded input back into the
 * union at the merge boundary.
 */
export type OpenAIInput = OpenAIMessageInput | OpenAIRegenerateInput | OpenAIItemInput | OpenAIApprovalInput;

/** Whether a value is a non-null object whose keys can be read. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Narrow a decoded passthrough input to this demo's input union. The wire is
 * a trust boundary: an unrecognised body (another app's vocabulary on a
 * shared channel) narrows to `undefined` and the caller skips it.
 * @param input - The decoded input body.
 * @returns The narrowed input, or `undefined` when it is not one of ours.
 */
export const asOpenAIInput = (input: unknown): OpenAIInput | undefined => {
  if (!isRecord(input)) return undefined;
  const { kind, payload } = input;
  if (kind === 'regenerate') return { kind };
  if (kind === 'message' && isRecord(payload) && Array.isArray(payload.items)) {
    // CAST: trust boundary — this demo published the body; the items list is
    // OpenAI's own vocabulary.
    return { kind, payload: payload as unknown as OpenAIMessage };
  }
  if (kind === 'item' && isRecord(payload) && payload.type === 'function_call_output') {
    // CAST: trust boundary — validated envelope; `output` stays tool-defined.
    return { kind, payload: payload as unknown as Responses.ResponseInputItem.FunctionCallOutput };
  }
  if (kind === 'approval' && isRecord(payload) && typeof payload.call_id === 'string') {
    // CAST: trust boundary — validated envelope.
    return { kind, payload: payload as unknown as OpenAIApprovalDecision };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Model-input conversion
// ---------------------------------------------------------------------------

/**
 * Flatten a conversation into OpenAI Responses model input. The value of this
 * function is its signature: {@link OpenAIItem} is curated so every stored
 * item is a `ResponseInputItem`, and the flatten only assigns while that
 * invariant holds — adding a non-input member to the item union breaks the
 * build here rather than at the provider.
 * @param messages - The conversation messages.
 * @returns The concatenated items as a Responses `input` array.
 */
export const toResponsesInput = (messages: OpenAIMessage[]): Responses.ResponseInputItem[] =>
  messages.flatMap((message) => message.items);

// ---------------------------------------------------------------------------
// Agent-loop correlation readers
// ---------------------------------------------------------------------------

/**
 * The `call_id`s of every `function_call_output` present across the given
 * messages. A resolved call is one whose output has merged in, so the loop
 * skips it and a renderer shows its output attached to the call.
 * @param messages - The conversation messages to scan.
 * @returns The set of resolved `call_id`s.
 */
export const resolvedCallIds = (messages: OpenAIMessage[]): Set<string> => {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const item of message.items) {
      if (item.type === 'function_call_output') ids.add(item.call_id);
    }
  }
  return ids;
};

/**
 * Find the function calls that still owe the model an answer: a
 * `function_call` with no `function_call_output` that is not approved either.
 * An approved call counts as answered (the agent runs it server-side on
 * resume, before the next model turn); a denial is answered on the wire by a
 * `function_call_output` recording the rejection. A call still pending a
 * decision, and a client-executed call whose result has not arrived, are both
 * unanswered — resuming while any call is unanswered makes the provider
 * reject the request.
 * @param messages - The conversation messages to scan.
 * @returns The calls still awaiting an answer, in message/item order.
 */
export const unansweredCalls = (messages: OpenAIMessage[]): Responses.ResponseFunctionToolCall[] => {
  const resolved = resolvedCallIds(messages);
  const calls: Responses.ResponseFunctionToolCall[] = [];
  for (const message of messages) {
    const states = message.toolCallStates ?? {};
    for (const item of message.items) {
      if (item.type !== 'function_call' || resolved.has(item.call_id)) continue;
      if (states[item.call_id]?.approval !== 'approved') calls.push(item);
    }
  }
  return calls;
};

/**
 * Find the gated function calls the user has approved but the agent has not
 * yet run: a `function_call` whose approval is `'approved'` with no
 * `function_call_output` present. On resume the agent must run these
 * server-side before the next model turn.
 * @param messages - The conversation messages to scan.
 * @returns The approved-but-unexecuted gated calls, in message/item order.
 */
export const approvedUnexecutedCalls = (messages: OpenAIMessage[]): Responses.ResponseFunctionToolCall[] => {
  const resolved = resolvedCallIds(messages);
  const calls: Responses.ResponseFunctionToolCall[] = [];
  for (const message of messages) {
    const states = message.toolCallStates ?? {};
    for (const item of message.items) {
      if (item.type !== 'function_call' || resolved.has(item.call_id)) continue;
      if (states[item.call_id]?.approval === 'approved') calls.push(item);
    }
  }
  return calls;
};

/** Re-exported so demo modules import the modelled-item helpers alongside this model. */
export { isModelledOutputItem, type ModelledOutputItem };
