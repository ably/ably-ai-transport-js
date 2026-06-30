/**
 * Core-provided factories for the well-known input variants.
 *
 * Every codec's `TInput` union is built from the same well-known input shapes
 * ({@link UserMessage}, {@link Regenerate}, {@link ToolResult}, {@link
 * ToolResultError}, {@link ToolApprovalResponse}). The factory bodies that wrap
 * a domain value into one of these variants are fully determined by those
 * shapes, so they live here once rather than being re-implemented per codec.
 * {@link wellKnownInputs} returns them payload-typed to a given `TInput`, ready
 * to spread into a codec definition.
 */

import type {
  CodecInputEvent,
  Regenerate,
  ToolApprovalResponse,
  ToolApprovalResponsePayloadOf,
  ToolResult,
  ToolResultError,
  ToolResultErrorPayloadOf,
  ToolResultPayloadOf,
  UserMessage,
  UserMessageOf,
} from './types.js';

/**
 * The well-known input factory functions, payload-typed for a codec's `TInput`
 * union. A codec spreads these into its definition rather than re-implementing
 * the variant-wrapping boilerplate. Each factory returns the specific variant
 * it builds — a member of the codec's `TInput` union.
 * @template TInput - The codec's input union.
 */
export interface WellKnownInputFactories<TInput extends CodecInputEvent> {
  /**
   * Wrap a domain message as the codec's {@link UserMessage} variant.
   * @param message - The message in the codec's domain representation.
   * @returns The user-message input.
   */
  createUserMessage(message: UserMessageOf<TInput>): UserMessage<UserMessageOf<TInput>>;
  /**
   * Build a {@link Regenerate} input.
   * @param target - The codec-message-id of the assistant message to regenerate.
   * @param parent - The codec-message-id of the parent user message the new assistant threads under.
   * @returns The regenerate input.
   */
  createRegenerate(target: string, parent: string): Regenerate;
  /**
   * Build a {@link ToolResult} input addressing an assistant codec-message.
   * @param codecMessageId - The assistant codec-message carrying the tool call.
   * @param payload - The codec's domain payload describing the tool result.
   * @returns The tool-result input.
   */
  createToolResult(
    codecMessageId: string,
    payload: ToolResultPayloadOf<TInput>,
  ): ToolResult<ToolResultPayloadOf<TInput>>;
  /**
   * Build a {@link ToolResultError} input addressing an assistant codec-message.
   * @param codecMessageId - The assistant codec-message carrying the tool call.
   * @param payload - The codec's domain payload describing the failure.
   * @returns The tool-result-error input.
   */
  createToolResultError(
    codecMessageId: string,
    payload: ToolResultErrorPayloadOf<TInput>,
  ): ToolResultError<ToolResultErrorPayloadOf<TInput>>;
  /**
   * Build a {@link ToolApprovalResponse} input addressing an assistant codec-message.
   * @param codecMessageId - The assistant codec-message carrying the tool call.
   * @param payload - The codec's domain payload describing the approval decision.
   * @returns The tool-approval-response input.
   */
  createToolApprovalResponse(
    codecMessageId: string,
    payload: ToolApprovalResponsePayloadOf<TInput>,
  ): ToolApprovalResponse<ToolApprovalResponsePayloadOf<TInput>>;
}

/** True when `TInput`'s union includes a member with the given `kind`. */
type HasInputKind<TInput extends CodecInputEvent, K extends string> = [Extract<TInput, { kind: K }>] extends [never]
  ? false
  : true;

/**
 * The well-known factories as they appear on a {@link DefinedCodec}: the
 * always-present user-message and regenerate factories, plus each tool factory
 * ONLY when `TInput` includes that variant (typed absent otherwise). This is
 * what lets a partial codec's `DefinedCodec` (one whose `TInput` omits the
 * tool variants, e.g. a text-only codec) stay assignable to {@link Codec}
 * (whose tool factories are optional), while keeping the tool factories callable
 * without a guard on a codec whose `TInput` does include the variant.
 *
 * TODO(AIT-742): reconsider this. {@link wellKnownInputs} cannot branch on
 * `TInput` (it is erased at runtime), so it always returns all five factory
 * bodies; this type hides the unsupported ones, and {@link defineCodec} bridges
 * the two with a single cast. The consequence is that a partial codec carries
 * tool-factory methods at runtime that its type denies — unreachable through the
 * typed surface, and harmless if forced (they build a value the codec has no
 * descriptor for, so it throws at encode), but still a smell. A cleaner shape
 * has each codec pass the factory set it wants into `defineCodec` (so the
 * runtime object and the type match exactly, with no cast and no phantom
 * method); deferred to avoid widening this change.
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
 * Build the {@link WellKnownInputFactories} for a codec's `TInput` union. The
 * returned factories wrap domain values into the well-known input variants and
 * are typically spread into a codec definition.
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
