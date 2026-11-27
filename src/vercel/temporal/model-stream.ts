/**
 * The stream parts of one model call, as Temporal's AI SDK plugin
 * (`@temporalio/vercel-ai-sdk`) publishes them to a Workflow Stream, turned
 * into the `UIMessageChunk`s the AI SDK's `toUIMessageStream` would give for
 * the same call.
 *
 * The plugin's streaming model Activity publishes each `LanguageModelV4`
 * stream part as JSON, encoded to bytes, and the workflow sees the call's
 * result only once the Activity ends. So the chunks a client streams are made
 * here, as the relay reads each part, rather than in the workflow. One call is
 * one step, so its `stream-start` opens a step and its `finish` ends it; the
 * chunks that open and end a whole reply, `start` and `finish`, are the
 * workflow's to publish.
 *
 * Each part maps on its own, so two details of `toUIMessageStream` that need
 * state across parts, or the workflow's tool definitions, are not repeated:
 * a text block's `providerMetadata` is on the delta that carried it rather
 * than on every later delta of the block, and a tool's chunks carry `dynamic`
 * only when the part does. The AI SDK's reducer keeps a part's metadata
 * across deltas, so the merged message is the same.
 *
 * The parts are read from the wire, so each is checked rather than trusted,
 * and the shapes below are declared here rather than imported from
 * `@ai-sdk/provider`. A part the AI SDK gives no chunk for, `tool-input-end`,
 * `response-metadata`, `raw` and `ping`, and `source` by default, gives none
 * here either. Any other part type without a mapping throws the codec's
 * no-row error, which the relay adaptor reports to the relay as an event it
 * cannot write, so the relay skips it, logs it and counts it.
 */

import * as Ably from '@ably/pubsub-core';
import type * as AI from 'ai';

import { noRowError } from '../../core/codec/define-codec.js';
import { isRecord } from '../../core/wire.js';
import { ErrorCode } from '../../errors.js';
import { errorMessage, stripUndefined } from '../../utils.js';

/** The error text a model's `error` part becomes, as the AI SDK's `toUIMessageStream` writes it by default, so a provider's error detail stays off the channel. */
const MASKED_ERROR = 'An error occurred.';

const decoder = new TextDecoder();

/**
 * The error a part that cannot be read throws.
 * @param reason - What is wrong with it.
 * @returns The error.
 */
const unreadable = (reason: string): Ably.ErrorInfo =>
  new Ably.ErrorInfo(`unable to write event; the model stream part ${reason}`, ErrorCode.InvalidArgument, 400);

/**
 * A string field of a part.
 * @param part - The part.
 * @param key - The field.
 * @returns The value.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the field is not a string.
 */
const stringOf = (part: Record<string, unknown>, key: string): string => {
  const value = part[key];
  if (typeof value !== 'string') throw unreadable(`${String(part.type)} has no string ${key}`);
  return value;
};

const optionalString = (part: Record<string, unknown>, key: string): string | undefined =>
  typeof part[key] === 'string' ? part[key] : undefined;

const optionalBoolean = (part: Record<string, unknown>, key: string): boolean | undefined =>
  typeof part[key] === 'boolean' ? part[key] : undefined;

const metadataOf = (part: Record<string, unknown>): AI.ProviderMetadata | undefined =>
  // CAST: provider metadata is JSON keyed by provider; the AI SDK's own type
  // is that shape, which a record check is as far as the wire can be checked.
  isRecord(part.providerMetadata) ? (part.providerMetadata as AI.ProviderMetadata) : undefined;

/**
 * The chunk for a `tool-call` part: its input parsed, or a `tool-input-error`
 * when the model's input is not JSON, as the AI SDK reports an invalid call.
 * @param part - The part.
 * @returns The chunk.
 */
const toolCallChunk = (part: Record<string, unknown>): AI.UIMessageChunk => {
  const toolCallId = stringOf(part, 'toolCallId');
  const toolName = stringOf(part, 'toolName');
  const raw = stringOf(part, 'input');
  const common = {
    toolCallId,
    toolName,
    providerExecuted: optionalBoolean(part, 'providerExecuted'),
    providerMetadata: metadataOf(part),
    dynamic: optionalBoolean(part, 'dynamic'),
  };
  let input: unknown;
  try {
    input = raw === '' ? {} : JSON.parse(raw);
  } catch (error) {
    // The AI SDK marks a call it could not parse dynamic, so its reducer
    // keeps it as a dynamic tool part rather than one typed by its name.
    return stripUndefined({
      type: 'tool-input-error' as const,
      ...common,
      dynamic: true,
      input: raw,
      errorText: `Invalid input for tool ${toolName}: ${errorMessage(error)}`,
    });
  }
  return stripUndefined({ type: 'tool-input-available' as const, ...common, input });
};

/**
 * The chunk for a `tool-result` part, which only a tool the provider runs
 * produces: an error result becomes `tool-output-error`.
 * @param part - The part.
 * @returns The chunk.
 */
const toolResultChunk = (part: Record<string, unknown>): AI.UIMessageChunk => {
  const toolCallId = stringOf(part, 'toolCallId');
  const providerExecuted = optionalBoolean(part, 'providerExecuted');
  if (part.isError === true) {
    const { result } = part;
    return stripUndefined({
      type: 'tool-output-error' as const,
      toolCallId,
      errorText: typeof result === 'string' ? result : JSON.stringify(result),
      providerExecuted,
    });
  }
  return stripUndefined({
    type: 'tool-output-available' as const,
    toolCallId,
    output: part.result,
    providerExecuted,
    providerMetadata: metadataOf(part),
    preliminary: optionalBoolean(part, 'preliminary'),
    dynamic: optionalBoolean(part, 'dynamic'),
  });
};

/**
 * The chunk for a part that has one.
 * @param part - The part, checked to have a string `type`.
 * @returns The chunk, or `undefined` for a part the AI SDK gives no chunk for.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a field the chunk needs is missing, or, marked as the codec's no-row error, for a part type with no mapping here.
 */
const chunkOfPart = (part: Record<string, unknown> & { type: string }): AI.UIMessageChunk | undefined => {
  switch (part.type) {
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end': {
      return stripUndefined({ type: part.type, id: stringOf(part, 'id'), providerMetadata: metadataOf(part) });
    }
    case 'text-delta':
    case 'reasoning-delta': {
      return stripUndefined({
        type: part.type,
        id: stringOf(part, 'id'),
        delta: stringOf(part, 'delta'),
        providerMetadata: metadataOf(part),
      });
    }
    case 'tool-input-start': {
      return stripUndefined({
        type: 'tool-input-start' as const,
        toolCallId: stringOf(part, 'id'),
        toolName: stringOf(part, 'toolName'),
        providerExecuted: optionalBoolean(part, 'providerExecuted'),
        providerMetadata: metadataOf(part),
        dynamic: optionalBoolean(part, 'dynamic'),
        title: optionalString(part, 'title'),
      });
    }
    case 'tool-input-delta': {
      return { type: 'tool-input-delta', toolCallId: stringOf(part, 'id'), inputTextDelta: stringOf(part, 'delta') };
    }
    case 'tool-call': {
      return toolCallChunk(part);
    }
    case 'tool-result': {
      return toolResultChunk(part);
    }
    case 'stream-start': {
      return { type: 'start-step' };
    }
    case 'finish': {
      return { type: 'finish-step' };
    }
    case 'error': {
      return { type: 'error', errorText: MASKED_ERROR };
    }
    // The AI SDK gives no chunk for these either (`source` only when asked).
    case 'tool-input-end':
    case 'response-metadata':
    case 'raw':
    case 'ping':
    case 'source': {
      return undefined;
    }
    // Every other type, the ones the AI SDK gives a chunk for that is not
    // made here (`file`, `reasoning-file`, `custom`, `tool-approval-request`)
    // and the ones it does not know, is reported as having no row, so a relay
    // skips the part and counts it rather than dropping it unseen.
    default: {
      throw noRowError(part.type);
    }
  }
};

/**
 * The `UIMessageChunk` for one model stream part, as the plugin publishes it.
 * @param bytes - The part, JSON encoded to bytes.
 * @returns The chunk, or `undefined` for a part the AI SDK gives no chunk for.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the bytes are not JSON of an object with a string `type`, or a part lacks a field its chunk needs; marked as the codec's no-row error for a part type with no mapping here.
 */
export const chunkOfModelStreamPart = (bytes: Uint8Array): AI.UIMessageChunk | undefined => {
  let part: unknown;
  try {
    part = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw unreadable(`is not JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(part) || typeof part.type !== 'string') throw unreadable('has no string type');
  // CAST: the check above narrows `type`, which TypeScript does not carry onto the record.
  return chunkOfPart(part as Record<string, unknown> & { type: string });
};
