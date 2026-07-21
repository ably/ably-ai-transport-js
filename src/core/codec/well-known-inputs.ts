/**
 * Core-provided factories for the well-known input variants.
 *
 * Every codec's `TInput` union is built from the same well-known input shapes
 * ({@link UserMessage}, {@link Regenerate}, {@link ToolResult}, {@link
 * ToolResultError}, {@link ToolApprovalResponse}). The factory bodies that wrap
 * a domain value into one of these variants are fully determined by those
 * shapes, so they live here once rather than being re-implemented per codec.
 * {@link wellKnownInputs} returns them payload-typed to a given `TInput`;
 * `defineCodec` calls it and hands the set to a codec's `factories` selector,
 * which returns the subset the codec exposes.
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
 * union. `defineCodec` hands this full set to a codec's `factories` selector,
 * which returns the subset the codec exposes; `defineCodec` spreads that subset
 * onto the assembled codec, so no codec re-implements the variant-wrapping
 * boilerplate. Each factory returns the specific variant it builds — a member
 * of the codec's `TInput` union.
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
 * The well-known factories as they appear on a {@link DefinedCodec}: the
 * always-present user-message and regenerate factories, plus each tool factory
 * ONLY when `TInput` includes that variant (typed absent otherwise). A codec's
 * `factories` selector (see `DefineCodecConfig`) returns a value of this type,
 * picking from the full {@link WellKnownInputFactories} set the subset its
 * `TInput` supports; `defineCodec` spreads that result onto the codec, so the
 * runtime object carries exactly those factories. This is what lets a partial
 * codec's `DefinedCodec` (one whose `TInput` omits the tool variants, e.g. a
 * text-only codec) stay assignable to {@link Codec} (whose tool factories are
 * optional), while a full codec keeps its tool factories callable without a
 * guard.
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
 * returned factories wrap domain values into the well-known input variants.
 * `defineCodec` calls this and passes the set to a codec's `factories` selector,
 * which returns the subset the codec exposes.
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
