/**
 * Vercel codec input/output unions.
 *
 * The codec splits cleanly along the protocol's `ai-input` / `ai-output`
 * wire boundary:
 *
 * - **`VercelOutput`** = `AI.UIMessageChunk` — the AI SDK's streamed-output
 *   domain model, published by the agent on `ai-output`.
 * - **`VercelInput`** = the bodies a client publishes on `ai-input`. Each
 *   body is the provider's own vocabulary where one exists — a `UIMessage`
 *   for a new turn, a `tool-output-*` chunk for a tool resolution — so the
 *   provider's own reducer (`readUIMessageStream`) folds inputs and outputs
 *   through one code path. The approval decision is the one action with no
 *   provider-typed body, so the codec defines a small body of its own.
 *
 * Addressing never rides an input: the transport's publish options carry the
 * `codecMessageId` / `parent` / `regenerates` structure, and `WireMeta`
 * reports them on the way back.
 */

import type * as AI from 'ai';

// ---------------------------------------------------------------------------
// Input bodies
// ---------------------------------------------------------------------------

/**
 * The chunk-shaped action bodies: the AI SDK's own tool-resolution chunks
 * (`tool-output-available`, `tool-output-error`, `tool-output-denied`),
 * selected structurally by their `tool-output-` prefix so the union tracks
 * the installed `ai` major without naming a variant one major lacks.
 */
export type VercelToolOutputChunk = Extract<AI.UIMessageChunk, { type: `tool-output-${string}` }>;

/**
 * The approval decision for a tool the agent gated behind a
 * `tool-approval-request`. The AI SDK has no chunk for this client-side
 * action (a response is `chat.addToolApprovalResponse`, not a stream part),
 * so the codec defines the body: it captures "approved, not yet executed" —
 * the intermediate state the `useChat` adapter reads to avoid publishing the
 * same resolution twice.
 */
export interface VercelApprovalDecision {
  /**
   * The `UIMessage.id` of the assistant message holding the gated tool call.
   * The application's merge routes the decision onto that message by this id,
   * the same way it routes a `tool-output-*` chunk. Domain data in the same
   * class as {@link toolCallId}, deliberately carried in the body rather than
   * as wire addressing.
   */
  messageId: string;
  /** The tool call the decision concerns. */
  toolCallId: string;
  /** Whether the user approved the tool execution. */
  approved: boolean;
  /** Optional human-readable reason (typically used on denial). */
  reason?: string;
}

/**
 * A new conversation turn: the message body is the AI SDK's own `UIMessage`,
 * so an application folds it with the same provider machinery that folds the
 * output chunks.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing the message's tool parts.
 */
export interface VercelMessageInput<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /** Discriminator. */
  kind: 'message';
  /** The message for the turn, in the AI SDK's own domain type. */
  payload: AI.UIMessage<TMetadata, TDataParts, TTools>;
}

/**
 * A regeneration signal, naming the message useChat is regenerating from.
 * The id is domain data the agent interprets; it describes no conversation
 * structure and the transport does not read it.
 */
export interface VercelRegenerateInput {
  /** Discriminator. */
  kind: 'regenerate';
  /** Which message is being regenerated. */
  payload: {
    /**
     * The `UIMessage.id` useChat is regenerating from. The transport carries
     * the field and never reads it; what the agent does with it — typically
     * truncating its stored conversation there — is the application's choice.
     */
    messageId: string;
  };
}

/**
 * A tool resolution: the body is the AI SDK's own tool-output chunk, published
 * against the assistant message it amends (addressed by the publish options'
 * `codecMessageId`). Two resolutions on one assistant address distinct tool
 * calls, matched inside the body by `toolCallId`, so last-writer-wins per part
 * merges them without contest.
 */
export interface VercelChunkInput {
  /** Discriminator. */
  kind: 'chunk';
  /** The tool-resolution chunk, in the AI SDK's own chunk vocabulary. */
  payload: VercelToolOutputChunk;
}

/**
 * A tool-approval decision, published against the assistant message whose
 * tool call it gates (addressed by the publish options' `codecMessageId`).
 * See {@link VercelApprovalDecision} for why this body is codec-defined.
 */
export interface VercelApprovalInput {
  /** Discriminator. */
  kind: 'approval';
  /** The approval decision. */
  payload: VercelApprovalDecision;
}

/**
 * The Vercel codec's `TInput` — every body a client publishes on the
 * `ai-input` wire. The generic params thread through the message arm's
 * `AI.UIMessage`; the chunk and approval arms do not depend on them. Each
 * defaults to the SDK default, so an unparameterized `VercelInput` resolves
 * to the all-defaults instantiation.
 * @template TMetadata - Per-message metadata type carried by a message input.
 * @template TDataParts - Custom data-part types on a message input.
 * @template TTools - Tool set typing the message input's tool parts.
 */
export type VercelInput<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> = VercelMessageInput<TMetadata, TDataParts, TTools> | VercelRegenerateInput | VercelChunkInput | VercelApprovalInput;

// ---------------------------------------------------------------------------
// Output union
// ---------------------------------------------------------------------------

/**
 * The Vercel codec's `TOutput` — every record-shape the agent publishes
 * on the `ai-output` wire. The Vercel codec passes the AI SDK's
 * `UIMessageChunk` through unchanged.
 *
 * Derived via {@link AI.InferUIMessageChunk} from the consumer's
 * `AI.UIMessage<TMetadata, TDataParts>`, so a streamed chunk's `messageMetadata`
 * and data-part payloads carry the consumer's types (the chunk shape has no
 * tool parameter — tool typing lands on the assistant's message parts). Both
 * default to the SDK default, so an unparameterized `VercelOutput` resolves to the all-defaults instantiation.
 * @template TMetadata - Per-message metadata type carried on lifecycle chunks.
 * @template TDataParts - Custom data-part types on `data-*` chunks.
 */
export type VercelOutput<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
> = AI.InferUIMessageChunk<AI.UIMessage<TMetadata, TDataParts>>;
