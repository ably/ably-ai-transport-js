/**
 * Type bindings for the OpenAI Responses codec.
 *
 * Binds the four `Codec` generic parameters to OpenAI's Responses types. The
 * codec passes the raw Responses event stream through as `TOutput` and renders
 * a turn as a list of OpenAI items (`TMessage`), which are simultaneously the
 * canonical renderable form and valid model input.
 *
 * This increment covers streamed assistant text only; function calls,
 * reasoning, refusals, and hosted tools are added in later increments by
 * extending the descriptor table and reducer, not by changing these bindings.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { UserMessage } from '../../core/codec/index.js';

/**
 * `TOutput` — the agent publishes raw Responses stream events on the `ai-output`
 * wire, passed through verbatim (mirroring how the Vercel codec binds
 * `AI.UIMessageChunk`). The descriptor table and reducer handle a subset of the
 * union and ignore the rest.
 */
export type OpenAIOutput = Responses.ResponseStreamEvent;

/**
 * A single item within a turn. Assistant turns hold {@link Responses.ResponseOutputItem}s
 * (e.g. an output message); user turns hold a {@link Responses.ResponseInputItem}
 * (an input message). The union is deliberate: OpenAI's output items are also
 * valid model-input items, so a turn's items are simultaneously what the UI
 * renders and what is sent back to the model.
 */
export type OpenAIItem = Responses.ResponseOutputItem | Responses.ResponseInputItem;

/**
 * `TMessage` — one turn's worth of OpenAI items, tagged with the turn's role.
 * One run renders as one assistant turn; one prompt as one user turn.
 * System/developer instructions are server-side configuration and never appear
 * here.
 *
 * `items` is a list because an **assistant** turn can hold several output items
 * (a message plus one or more function calls). A **user** turn is expected to
 * be a single input message *item*; the input codec relies on that (see
 * `inputs`). Note "single message" is not "single part": that one message item
 * can carry multiple content parts (text today; image/file later) in its
 * `content` array — the multiplicity for a user turn lives in the parts, not
 * the items.
 *
 * The list does not encode that user/assistant asymmetry in the type — a
 * possible future tightening is a role-discriminated `TMessage`.
 */
export interface OpenAITurn {
  /** Whether this turn is the user's prompt or the assistant's reply. */
  role: 'user' | 'assistant';
  /** The turn's items, in wire order. */
  items: OpenAIItem[];
}

/**
 * `TInput` — what the client publishes on the `ai-input` wire. This increment
 * supports only the well-known user-message variant; tool results and approval
 * responses join the union when client-side tools land.
 */
export type OpenAIInput = UserMessage<OpenAITurn>;
