/**
 * The session layer's codec contract: the full reducer + factory codec the
 * sessions and the Tree consume.
 *
 * The core codec surface (`src/core/codec/`) is wire-only — encode and decode,
 * nothing else. The session layer additionally needs a reducer that folds
 * events into a per-node projection, a `getMessages` extraction the Tree and
 * View read, and the well-known input taxonomy (`UserMessage`, `Regenerate`,
 * the tool variants) its send paths construct. Those contracts live here,
 * owned by the session layer that consumes them, so the wire tier carries no
 * session concepts. {@link defineSessionCodec} assembles a full session codec
 * from a wire codec definition plus the reducer and factory parts.
 */

import type { DefineCodecConfig } from '../codec/define-codec.js';
import { defineCodec } from '../codec/define-codec.js';
import type { DecodedMessage, WireCodec } from '../codec/types.js';

// ---------------------------------------------------------------------------
// Codec input events — well-known input variant shapes
// ---------------------------------------------------------------------------

/**
 * Structural base every session-codec input variant satisfies. The session
 * layer's send paths read the routing fields directly off the variant to stamp
 * wire headers, so no runtime classification step is needed.
 */
export interface CodecInputEvent {
  /** Discriminator. The well-known variants pin their literals; codec-specific variants pick any other. */
  kind: string;
  /**
   * Sets the wire `parent` header — the codec-message-id of the preceding
   * codec-message on this branch. When omitted, the SDK auto-computes the
   * parent from the visible branch tail at send time.
   */
  parent?: string;
  /**
   * Pointer to another codec-message this input references. The semantic
   * depends on `kind` — for `regenerate`, the assistant codec-message to
   * regenerate.
   */
  target?: string;
  /**
   * Targets an existing codec-message-id instead of minting a fresh one. Used
   * by continuation inputs (tool results, approval responses) that amend an
   * existing assistant message rather than creating a new one.
   */
  codecMessageId?: string;
}

/**
 * Structural base every session-codec output variant satisfies: a `type`
 * discriminator, so the reducer can switch on it.
 */
export interface CodecOutputEvent {
  /** Discriminator. Codec authors pick the literal value per variant. */
  type: string;
}

/**
 * Well-known input variant: a new user message in the codec's domain
 * representation. Pinned `kind: 'user-message'`.
 * @template TMessage - The codec's per-message domain type.
 */
export interface UserMessage<TMessage> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'user-message';
  /** The user's message in the codec's domain representation. */
  message: TMessage;
}

/**
 * Well-known input variant: request that an existing assistant codec-message
 * be regenerated. Pinned `kind: 'regenerate'`. A signal, not itself a fork:
 * `target` names the assistant message to regenerate, `parent` the user
 * message the new assistant threads under.
 */
export interface Regenerate extends CodecInputEvent {
  /** Discriminator. */
  kind: 'regenerate';
  /** The codec-message-id of the assistant to regenerate. Required. */
  target: string;
  /** The codec-message-id of the parent user message the new assistant threads under. Required. */
  parent: string;
}

/**
 * Well-known input variant: client-published tool result (success). Mutates
 * the assistant codec-message addressed by `codecMessageId`.
 * @template TPayload - The codec's domain payload for a tool result.
 */
export interface ToolResult<TPayload> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'tool-result';
  /**
   * The assistant codec-message containing the tool call. Present on a
   * locally constructed input (the factories set it); absent on a
   * wire-decoded input, where the wire `codec-message-id` header carries the
   * addressing and the fold reads it from the reducer meta.
   */
  codecMessageId?: string;
  /** The codec's domain payload describing the tool result. */
  payload: TPayload;
}

/**
 * Well-known input variant: client-published tool result (failure). Mutates
 * the assistant codec-message addressed by `codecMessageId`.
 * @template TPayload - The codec's domain payload for a tool-result failure.
 */
export interface ToolResultError<TPayload> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'tool-result-error';
  /**
   * The assistant codec-message containing the tool call. Present on a
   * locally constructed input (the factories set it); absent on a
   * wire-decoded input, where the wire `codec-message-id` header carries the
   * addressing and the fold reads it from the reducer meta.
   */
  codecMessageId?: string;
  /** The codec's domain payload describing the failure. */
  payload: TPayload;
}

/**
 * Well-known input variant: client-published response to an agent-emitted
 * tool-approval request. Mutates the assistant codec-message addressed by
 * `codecMessageId`.
 * @template TPayload - The codec's domain payload for an approval response.
 */
export interface ToolApprovalResponse<TPayload> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'tool-approval-response';
  /**
   * The assistant codec-message containing the tool call. Present on a
   * locally constructed input (the factories set it); absent on a
   * wire-decoded input, where the wire `codec-message-id` header carries the
   * addressing and the fold reads it from the reducer meta.
   */
  codecMessageId?: string;
  /** The codec's domain payload describing the approval decision. */
  payload: TPayload;
}

/**
 * Extract the domain `payload` type of a codec's {@link ToolResult} member
 * from its `TInput` union, or `never` if absent.
 * @template TInput - The codec's input union.
 */
export type ToolResultPayloadOf<TInput> = TInput extends ToolResult<infer P> ? P : never;

/**
 * Extract the domain `payload` type of a codec's {@link ToolResultError}
 * member from its `TInput` union, or `never` if absent.
 * @template TInput - The codec's input union.
 */
export type ToolResultErrorPayloadOf<TInput> = TInput extends ToolResultError<infer P> ? P : never;

/**
 * Extract the domain `payload` type of a codec's {@link ToolApprovalResponse}
 * member from its `TInput` union, or `never` if absent.
 * @template TInput - The codec's input union.
 */
export type ToolApprovalResponsePayloadOf<TInput> = TInput extends ToolApprovalResponse<infer P> ? P : never;

/**
 * Extract the domain message type (`TMessage`) carried by a codec's
 * {@link UserMessage} member from its `TInput` union, or `never` if absent.
 * @template TInput - The codec's input union.
 */
export type UserMessageOf<TInput> = TInput extends UserMessage<infer M> ? M : never;

// ---------------------------------------------------------------------------
// Reducer — pure event-sourced state machine
// ---------------------------------------------------------------------------

/**
 * Transport-derived metadata passed alongside each event into `fold`. Read by
 * the Tree from the inbound Ably message and stamped before each fold call.
 */
export interface ReducerMeta {
  /**
   * Ably channel serial of the wire message that produced this event, or `''`
   * for a not-yet-sequenced optimistic (local) fold. Ordering context only:
   * the Tree invokes `fold` in canonical serial order and exactly once per
   * event, so the reducer must not treat a same-or-lower serial as a replay to
   * skip — ordering and dedup are the Tree's job, not the reducer's.
   */
  serial: string;
  /**
   * Optional `codec-message-id` from the inbound Ably message. Reducers use
   * this to route an event to a target message within the projection (e.g. to
   * amend an existing assistant message addressed by its codec-message-id).
   */
  messageId?: string;
}

/**
 * A decoded event tagged with the wire direction it arrived on. The reducer
 * folds this union (not a bare `TInput | TOutput`) so it can dispatch on
 * `direction` rather than inspecting the event's shape. Direction is derived
 * once, from the Ably message name, at decode time (see {@link toCodecEvents}).
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 */
export type CodecEvent<TInput, TOutput> =
  | {
      /** The event arrived on the `ai-input` wire. */
      readonly direction: 'input';
      /** The decoded input event. */
      readonly event: TInput;
    }
  | {
      /** The event arrived on the `ai-output` wire. */
      readonly direction: 'output';
      /** The decoded output event. */
      readonly event: TOutput;
    };

/**
 * Tag a decoded message's events with their wire direction, inputs first
 * (a message is single-direction, so the relative order of the two groups is
 * immaterial).
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @param decoded - The decoder's input/output split for one inbound message.
 * @returns The events as a direction-tagged {@link CodecEvent} list.
 */
export const toCodecEvents = <TInput, TOutput>(
  decoded: DecodedMessage<TInput, TOutput>,
): CodecEvent<TInput, TOutput>[] => [
  ...decoded.inputs.map((event): CodecEvent<TInput, TOutput> => ({ direction: 'input', event })),
  ...decoded.outputs.map((event): CodecEvent<TInput, TOutput> => ({ direction: 'output', event })),
];

/**
 * Pure, stateless reducer contract. A reducer folds events into an opaque
 * TProjection. Ordering, deduplication, and replay are the Tree's
 * responsibility, not the reducer's: the Tree invokes `fold` exactly once per
 * event, in canonical order, refolding a node from a fresh `init` when a late
 * wire would otherwise land out of order. `fold` may mutate the projection
 * passed in and return it — the caller treats the projection as single-owner.
 * @template TEvent - The direction-tagged event union the reducer folds.
 * @template TProjection - The opaque per-node state.
 */
export interface Reducer<TEvent, TProjection> {
  /**
   * Build an empty initial projection. Called once per conversation node
   * before any of that node's events are folded, and again on every refold.
   */
  init(): TProjection;
  /**
   * Fold one event into the projection and return the updated projection.
   * Invoked exactly once per event, in canonical order; may mutate `state`.
   */
  fold(state: TProjection, event: TEvent, meta: ReducerMeta): TProjection;
}

/**
 * A single domain message paired with the codec-message-id that identifies it
 * on the wire. Returned from {@link Codec.getMessages}. `message` is
 * reconstructed to faithfully reproduce the values the source produced and is
 * surfaced to the application as-is; all internal correlation keys on
 * `codecMessageId`.
 * @template TMessage - The codec's per-message domain type.
 */
export interface CodecMessage<TMessage> {
  /** The SDK's codec-message-id for this message — the correlation key. */
  codecMessageId: string;
  /** The domain message, reconstructed verbatim from the source values. */
  message: TMessage;
}

// ---------------------------------------------------------------------------
// Codec — the full contract the sessions and the Tree consume
// ---------------------------------------------------------------------------

/**
 * The full session codec: the wire tier plus the reducer that folds events
 * into a per-node projection, the projection-extraction surface the Tree
 * consumes, and the well-known input factories the session send paths call.
 * The sessions require this contract; a transport-only consumer needs just
 * the {@link WireCodec} slice.
 * @template TInput - The union of input variants the client publishes.
 * @template TOutput - The union of output variants the agent publishes.
 * @template TProjection - The opaque per-node state the reducer folds into.
 * @template TMessage - The per-message shape consumed by the Tree.
 */
export interface Codec<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>
  extends WireCodec<TInput, TOutput>, Reducer<CodecEvent<TInput, TOutput>, TProjection> {
  /**
   * Extract the per-message list from a projection, each message paired with
   * its codec-message-id (see {@link CodecMessage}).
   */
  getMessages(projection: TProjection): CodecMessage<TMessage>[];
  /**
   * Wrap a TMessage as the codec's well-known {@link UserMessage} variant,
   * returned as a `TInput` ready to publish on the `ai-input` wire.
   * @param message - The user's message in the codec's domain representation.
   * @returns A `TInput` (the codec's {@link UserMessage} variant).
   */
  createUserMessage(message: TMessage): TInput;
  /**
   * Build a {@link Regenerate} for the codec, returned as a `TInput`. The View
   * calls this from `regenerate(messageId)`.
   * @param target - The codec-message-id of the assistant being regenerated.
   * @param parent - The codec-message-id of the parent user message the new assistant threads under.
   * @returns A `TInput` (the codec's {@link Regenerate} variant).
   */
  createRegenerate(target: string, parent: string): TInput;
  /**
   * Build a {@link ToolResult} for the codec, returned as a `TInput`.
   * Optional — only codecs whose `TInput` includes the variant implement it.
   * @param codecMessageId - The assistant codec-message the result amends.
   * @param payload - The codec's domain tool-result payload.
   * @returns A `TInput` (the codec's {@link ToolResult} variant).
   */
  createToolResult?(codecMessageId: string, payload: ToolResultPayloadOf<TInput>): TInput;
  /**
   * Build a {@link ToolResultError} for the codec, returned as a `TInput`.
   * Optional — only codecs whose `TInput` includes the variant implement it.
   * @param codecMessageId - The assistant codec-message the error amends.
   * @param payload - The codec's domain tool-result-failure payload.
   * @returns A `TInput` (the codec's {@link ToolResultError} variant).
   */
  createToolResultError?(codecMessageId: string, payload: ToolResultErrorPayloadOf<TInput>): TInput;
  /**
   * Build a {@link ToolApprovalResponse} for the codec, returned as a
   * `TInput`. Optional — only codecs whose `TInput` includes the variant
   * implement it.
   * @param codecMessageId - The assistant codec-message the response amends.
   * @param payload - The codec's domain approval-decision payload.
   * @returns A `TInput` (the codec's {@link ToolApprovalResponse} variant).
   */
  createToolApprovalResponse?(codecMessageId: string, payload: ToolApprovalResponsePayloadOf<TInput>): TInput;
}

// ---------------------------------------------------------------------------
// Well-known input factories
// ---------------------------------------------------------------------------

/**
 * The well-known input factory functions, payload-typed for a codec's `TInput`
 * union. {@link defineSessionCodec} hands this full set to a codec's
 * `factories` selector, which returns the subset the codec exposes.
 * @template TInput - The codec's input union.
 */
export interface WellKnownInputFactories<TInput extends CodecInputEvent> {
  /**
   * Wrap a domain message as the codec's {@link UserMessage} variant.
   * @param message - The message in the codec's domain representation.
   * @returns The user-message input.
   */
  createUserMessage: (message: UserMessageOf<TInput>) => UserMessage<UserMessageOf<TInput>>;
  /**
   * Build a {@link Regenerate} input.
   * @param target - The codec-message-id of the assistant message to regenerate.
   * @param parent - The codec-message-id of the parent user message the new assistant threads under.
   * @returns The regenerate input.
   */
  createRegenerate: (target: string, parent: string) => Regenerate;
  /**
   * Build a {@link ToolResult} input addressing an assistant codec-message.
   * @param codecMessageId - The assistant codec-message carrying the tool call.
   * @param payload - The codec's domain payload describing the tool result.
   * @returns The tool-result input.
   */
  createToolResult: (
    codecMessageId: string,
    payload: ToolResultPayloadOf<TInput>,
  ) => ToolResult<ToolResultPayloadOf<TInput>>;
  /**
   * Build a {@link ToolResultError} input addressing an assistant codec-message.
   * @param codecMessageId - The assistant codec-message carrying the tool call.
   * @param payload - The codec's domain payload describing the failure.
   * @returns The tool-result-error input.
   */
  createToolResultError: (
    codecMessageId: string,
    payload: ToolResultErrorPayloadOf<TInput>,
  ) => ToolResultError<ToolResultErrorPayloadOf<TInput>>;
  /**
   * Build a {@link ToolApprovalResponse} input addressing an assistant codec-message.
   * @param codecMessageId - The assistant codec-message carrying the tool call.
   * @param payload - The codec's domain payload describing the approval decision.
   * @returns The tool-approval-response input.
   */
  createToolApprovalResponse: (
    codecMessageId: string,
    payload: ToolApprovalResponsePayloadOf<TInput>,
  ) => ToolApprovalResponse<ToolApprovalResponsePayloadOf<TInput>>;
}

/** True when `TInput`'s union includes a member with the given `kind`. */
type HasInputKind<TInput extends CodecInputEvent, K extends string> = [Extract<TInput, { kind: K }>] extends [never]
  ? false
  : true;

/**
 * The well-known factories as they appear on a defined session codec: the
 * always-present user-message and regenerate factories, plus each tool factory
 * ONLY when `TInput` includes that variant (typed absent otherwise).
 * @template TInput - The codec's input union.
 */
export type DefinedCodecFactories<TInput extends CodecInputEvent> = Pick<
  WellKnownInputFactories<TInput>,
  'createUserMessage' | 'createRegenerate'
> &
  (HasInputKind<TInput, 'tool-result'> extends true
    ? Pick<WellKnownInputFactories<TInput>, 'createToolResult'>
    : { createToolResult?: undefined }) &
  (HasInputKind<TInput, 'tool-result-error'> extends true
    ? Pick<WellKnownInputFactories<TInput>, 'createToolResultError'>
    : { createToolResultError?: undefined }) &
  (HasInputKind<TInput, 'tool-approval-response'> extends true
    ? Pick<WellKnownInputFactories<TInput>, 'createToolApprovalResponse'>
    : { createToolApprovalResponse?: undefined });

/**
 * Build the {@link WellKnownInputFactories} for a codec's `TInput` union.
 * @template TInput - The codec's input union.
 * @returns The well-known input factory functions, payload-typed to `TInput`.
 */
export const wellKnownInputs = <TInput extends CodecInputEvent>(): WellKnownInputFactories<TInput> => ({
  createUserMessage: (message) => ({ kind: 'user-message', message }),
  createRegenerate: (target, parent) => ({ kind: 'regenerate', target, parent }),
  createToolResult: (codecMessageId, payload) => ({ kind: 'tool-result', codecMessageId, payload }),
  createToolResultError: (codecMessageId, payload) => ({ kind: 'tool-result-error', codecMessageId, payload }),
  createToolApprovalResponse: (codecMessageId, payload) => ({
    kind: 'tool-approval-response',
    codecMessageId,
    payload,
  }),
});

// ---------------------------------------------------------------------------
// defineSessionCodec — assemble a full session codec
// ---------------------------------------------------------------------------

/**
 * The reducer parts a session codec supplies. `TProjection` and `TMessage`
 * infer from these.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TProjection - The per-node projection the reducer folds into.
 * @template TMessage - The per-message domain type.
 */
export interface CodecReducer<TInput, TOutput, TProjection, TMessage> {
  /** Build an empty projection for a node. */
  init: () => TProjection;
  /** Fold one direction-tagged input or output event into the projection. */
  fold: (state: TProjection, event: CodecEvent<TInput, TOutput>, meta: ReducerMeta) => TProjection;
  /** Extract the per-message list (each paired with its codec-message-id). */
  getMessages: (projection: TProjection) => CodecMessage<TMessage>[];
}

/**
 * The parts a session codec supplies to {@link defineSessionCodec}: the wire
 * parts `defineCodec` takes, plus the reducer and the factory selector.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TProjection - The per-node projection the reducer folds into.
 * @template TMessage - The per-message domain type.
 */
export interface DefineSessionCodecConfig<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> extends DefineCodecConfig<TInput, TOutput> {
  /** Reducer parts; `TProjection` / `TMessage` infer from here. */
  reducer: CodecReducer<TInput, TOutput, TProjection, TMessage>;
  /**
   * Selects the well-known input factories this codec exposes. Receives the
   * full set of factory bodies (payload-typed to `TInput`) and returns the
   * subset the codec supports.
   */
  factories: (base: WellKnownInputFactories<TInput>) => DefinedCodecFactories<TInput>;
}

/**
 * A session codec assembled by {@link defineSessionCodec}: a conforming
 * {@link Codec} whose well-known input factory properties are typed by
 * {@link DefinedCodecFactories} — each tool factory present only when `TInput`
 * carries the matching variant.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TProjection - The per-node projection the reducer folds into.
 * @template TMessage - The per-message domain type.
 */
export type DefinedCodec<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> = Omit<Codec<TInput, TOutput, TProjection, TMessage>, keyof WellKnownInputFactories<TInput>> &
  DefinedCodecFactories<TInput>;

/**
 * Assemble a full session codec: the wire tier from {@link defineCodec}, plus
 * the reducer methods and the factory subset the `factories` selector returns.
 * Curried on the input/output unions so `TProjection` / `TMessage` infer from
 * `config.reducer`.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @returns A function taking the codec's parts and returning the assembled codec.
 */
export const defineSessionCodec =
  <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent>() =>
  <TProjection, TMessage>(
    config: DefineSessionCodecConfig<TInput, TOutput, TProjection, TMessage>,
  ): DefinedCodec<TInput, TOutput, TProjection, TMessage> => {
    const { reducer, factories, ...wire } = config;
    return {
      ...defineCodec<TInput, TOutput>()(wire),
      init: reducer.init,
      fold: reducer.fold,
      getMessages: reducer.getMessages,
      ...factories(wellKnownInputs<TInput>()),
    };
  };

// Re-exported so session-layer generics can reference the wire contracts from
// the same module as the session contract they extend.

export {
  type ChannelWriter,
  type DecodedMessage,
  type Decoder,
  type Encoder,
  type EncoderOptions,
  type WireCodec,
} from '../codec/types.js';
