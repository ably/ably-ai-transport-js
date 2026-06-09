/**
 * Vercel output (`ai-output`) event descriptors — the single source of truth for
 * encoding/decoding `UIMessageChunk` outputs. The generic drivers consume this
 * array; adding an ordinary output event is one entry here.
 *
 * Author-facing acceptance gate: this file contains **zero `as` casts**. The
 * curried `defineEvent`/`defineStream` helpers narrow each chunk member, so the
 * `data`/`encode`/`decode` callbacks are fully typed.
 */

import * as Ably from 'ably';

import { defineEvent, defineStream, type Descriptor } from '../../core/codec/descriptors.js';
import { boolField, jsonField, strField } from '../../core/codec/fields.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { parseJsonOrString, stripUndefined } from '../../utils.js';
import type { VercelOutput } from './events.js';
import {
  fDynamic,
  fFinishReason,
  fId,
  fMediaType,
  fMeta,
  fProviderExecuted,
  fSourceId,
  fTitle,
  fToolCallId,
  fToolName,
} from './fields.js';
import {
  isAgentToolOutputErrorWireData,
  isToolInputErrorWireData,
  isToolOutputAvailableWireData,
} from './wire-data.js';

const event = defineEvent<VercelOutput>();
const stream = defineStream<VercelOutput>();

const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

/** The Vercel codec's `ai-output` descriptors. */
export const outputs: Descriptor<VercelOutput>[] = [
  // --- streamed families -----------------------------------------------------

  stream('text', {
    start: 'text-start',
    delta: 'text-delta',
    end: 'text-end',
    idField: 'id',
    deltaField: 'delta',
    fields: [fId, fMeta],
  }),

  stream('reasoning', {
    start: 'reasoning-start',
    delta: 'reasoning-delta',
    end: 'reasoning-end',
    idField: 'id',
    deltaField: 'delta',
    fields: [fId, fMeta],
  }),

  // tool-input streams; the close step is a close-or-discrete fallback, the end
  // chunk reconstructs `input` from the accumulated text, and the family also
  // decodes from a non-streamed discrete publish.
  stream('tool-input', {
    start: 'tool-input-start',
    delta: 'tool-input-delta',
    end: 'tool-input-available',
    idField: 'toolCallId',
    deltaField: 'inputTextDelta',
    fields: [fToolCallId, fToolName, fDynamic, fTitle, fProviderExecuted, fMeta],
    onEnd: async (c, core, { h, name }) => {
      try {
        await core.closeStream(c.toolCallId, {
          name,
          data: '',
          codecHeaders: h(c, ['toolCallId', 'toolName', 'providerMetadata']),
        });
      } catch (error: unknown) {
        // closeStream raises InvalidArgument when there is no active stream for
        // this id; fall through to a discrete publish, rethrow anything else.
        if (!(error instanceof Ably.ErrorInfo && errorInfoIs(error, ErrorCode.InvalidArgument))) {
          throw error;
        }
        await core.publishDiscrete({ name, data: c.input, codecHeaders: h(c) });
      }
    },
    decodeEnd: ({ streamId, accumulated, codecHeaders, closingCodecHeaders }) => [
      stripUndefined({
        type: 'tool-input-available' as const,
        toolCallId: streamId,
        toolName: fToolName.read(closingCodecHeaders) || fToolName.read(codecHeaders),
        input: parseJsonOrString(accumulated),
        providerMetadata: fMeta.read(closingCodecHeaders),
      }),
    ],
    decodeDiscrete: ({ codecHeaders, data }) => [
      stripUndefined({
        type: 'tool-input-start' as const,
        toolCallId: fToolCallId.read(codecHeaders),
        toolName: fToolName.read(codecHeaders),
        dynamic: fDynamic.read(codecHeaders),
        title: fTitle.read(codecHeaders),
        providerExecuted: fProviderExecuted.read(codecHeaders),
        providerMetadata: fMeta.read(codecHeaders),
      }),
      stripUndefined({
        type: 'tool-input-available' as const,
        toolCallId: fToolCallId.read(codecHeaders),
        toolName: fToolName.read(codecHeaders),
        input: data,
        providerMetadata: fMeta.read(codecHeaders),
      }),
    ],
  }),

  // --- discrete lifecycle events ---------------------------------------------

  // `start` injects the encoder's configured messageId as a fallback, so it
  // builds its headers through a hatch rather than a pure descriptor.
  event('start', {
    fields: [strField('messageId'), jsonField('messageMetadata')],
    encode: async (c, core, { h, name, messageId, opts }) => {
      await core.publishDiscrete(
        { name, data: '', codecHeaders: h({ ...c, messageId: c.messageId ?? messageId }) },
        opts,
      );
    },
  }),
  event('start-step', { fields: [] }),
  event('finish-step', { fields: [] }),
  event('finish', {
    fields: [fFinishReason, jsonField('messageMetadata')],
  }),
  event('message-metadata', { fields: [jsonField('messageMetadata')] }),
  event('error', {
    fields: [],
    data: { encode: (c) => c.errorText, decode: (data) => ({ errorText: asString(data) }) },
  }),

  // abort: an ordinary discrete output carrying its reason as wire data. The
  // agent's own stream emits it on abort; run cancellation closes in-flight
  // streams via the encoder's cancelStreams() and terminates via the transport
  // ai-run-end event — this chunk is content, not the run terminator.
  event('abort', {
    fields: [],
    data: {
      encode: (c) => c.reason ?? '',
      decode: (data) => (typeof data === 'string' && data ? { reason: data } : {}),
    },
  }),

  // --- content parts ---------------------------------------------------------

  event('file', {
    fields: [fMediaType, fMeta],
    data: { encode: (c) => c.url, decode: (data) => ({ url: asString(data) }) },
  }),
  event('source-url', {
    fields: [fSourceId, fTitle, fMeta],
    data: { encode: (c) => c.url, decode: (data) => ({ url: asString(data) }) },
  }),
  event('source-document', {
    fields: [fSourceId, fMediaType, strField('title', ''), strField('filename'), fMeta],
  }),

  // --- tool lifecycle (discrete) ---------------------------------------------

  event('tool-input-error', {
    fields: [fToolCallId, fToolName, fDynamic, fTitle, fProviderExecuted, fMeta],
    data: {
      encode: (c) => ({ errorText: c.errorText, input: c.input }),
      decode: (data) =>
        isToolInputErrorWireData(data) ? { errorText: data.errorText ?? '', input: data.input } : { errorText: '' },
    },
  }),
  event('tool-output-available', {
    fields: [fToolCallId, fDynamic, fProviderExecuted, boolField('preliminary')],
    data: {
      encode: (c) => ({ output: c.output }),
      decode: (data) => (isToolOutputAvailableWireData(data) ? { output: data.output } : {}),
    },
  }),
  event('tool-output-error', {
    fields: [fToolCallId, fDynamic, fProviderExecuted],
    data: {
      encode: (c) => ({ errorText: c.errorText }),
      decode: (data) => ({ errorText: isAgentToolOutputErrorWireData(data) ? (data.errorText ?? '') : '' }),
    },
  }),
  event('tool-approval-request', {
    fields: [fToolCallId, strField('approvalId', '')],
  }),
  event('tool-output-denied', { fields: [fToolCallId] }),

  // --- data-* wildcard -------------------------------------------------------

  event('data-*', {
    matchType: (type) => type.startsWith('data-'),
    fields: [strField('id'), boolField('transient')],
    ephemeral: (c) => c.transient === true,
    data: { encode: (c) => c.data, decode: (data) => ({ data }) },
  }),
];
