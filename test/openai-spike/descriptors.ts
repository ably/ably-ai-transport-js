/**
 * AIT-742 Phase 0 spike — declarative descriptor tables for the Responses subset.
 *
 * This file is the evidence for hypotheses 1 and 7 (and the strain found in 3):
 *
 * - **Text streams cleanly.** `response.content_part.added` →
 *   `response.output_text.delta` → `response.output_text.done` map onto a
 *   `stream(...)` family with `idField: 'item_id'` and `deltaField: 'delta'`,
 *   both string-valued and present on all three phases. The string-append
 *   stream model fits (hyp 1).
 *
 * - **Function-call arguments CANNOT be a `stream(...)` family** under the
 *   current core contract. A stream needs a single top-level string `idField`
 *   shared by start/delta/end. The natural start boundary,
 *   `response.output_item.added`, exposes the id only nested under `item.id`
 *   (its sole top-level string key is the constant `type`), while the arg
 *   deltas use top-level `item_id`. There is no third `item_id`-bearing
 *   function-call event to serve as a distinct start. So the args are modelled
 *   as **discrete events** here (each delta its own message). This works with
 *   no core change but loses wire-level append-streaming for tool args — the
 *   precise strain behind hyp 3/7 (see the findings note).
 *
 * - **The split holds** (hyp 7): lifecycle + structural + function-call events
 *   are `event(...)` discretes carrying no string stream and hence no coarse
 *   `status`; text is the one `stream(...)` family carrying `status`.
 */

import type { OutputBuilder, OutputDescriptor } from '../../src/core/codec/index.js';
import { jsonField, strField } from '../../src/core/codec/index.js';
import type { OpenAIInput, OpenAIOutput } from './events.js';
import type { InputBuilder, InputDescriptor } from '../../src/core/codec/index.js';
import type { Response, ResponseContentPartAddedEvent, ResponseOutputItem } from 'openai/resources/responses/responses';

const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

// Numeric / object header fields used by the text stream reconstruction.
const fItemId = strField('item_id');
const fOutputIndex = jsonField<number, 'output_index'>('output_index');
const fContentIndex = jsonField<number, 'content_index'>('content_index');
const fPart = jsonField<ResponseContentPartAddedEvent['part'], 'part'>('part');

export const outputs = ({ event, stream }: OutputBuilder<OpenAIOutput>): readonly OutputDescriptor<OpenAIOutput>[] => [
  // --- the one streamed family: assistant text -------------------------------
  stream('text', {
    start: 'response.content_part.added',
    delta: 'response.output_text.delta',
    end: 'response.output_text.done',
    streamId: { field: 'item_id' },
    deltaField: 'delta',
    fields: [fItemId, fOutputIndex, fContentIndex, fPart],
    deltaFields: [fItemId],
    // The end chunk's `text` is the accumulated stream; indices come off the
    // closing headers. (item_id is the stream id.)
    decodeEnd: ({ streamId, accumulated, closingCodecHeaders, codecHeaders }) => [
      {
        type: 'response.output_text.done',
        item_id: streamId,
        output_index: fOutputIndex.read(closingCodecHeaders) ?? fOutputIndex.read(codecHeaders) ?? 0,
        content_index: fContentIndex.read(closingCodecHeaders) ?? fContentIndex.read(codecHeaders) ?? 0,
        text: accumulated,
        logprobs: [],
        sequence_number: 0,
      },
    ],
  }),

  // --- lifecycle (discrete; carry the Response snapshot) ----------------------
  event('response.created', {
    data: { encode: (c) => c.response, decode: (d) => ({ response: d as Response }) },
  }),
  event('response.in_progress', {
    data: { encode: (c) => c.response, decode: (d) => ({ response: d as Response }) },
  }),
  event('response.completed', {
    data: { encode: (c) => c.response, decode: (d) => ({ response: d as Response }) },
  }),
  event('response.failed', {
    data: { encode: (c) => c.response, decode: (d) => ({ response: d as Response }) },
  }),
  event('response.incomplete', {
    data: { encode: (c) => c.response, decode: (d) => ({ response: d as Response }) },
  }),
  event('error', {
    data: { encode: (c) => c.message, decode: (d) => ({ message: asString(d) }) },
  }),

  // --- structural item envelopes (discrete) -----------------------------------
  event('response.output_item.added', {
    data: { encode: (c) => c.item, decode: (d) => ({ item: d as ResponseOutputItem }) },
  }),
  event('response.output_item.done', {
    data: { encode: (c) => c.item, decode: (d) => ({ item: d as ResponseOutputItem }) },
  }),
  event('response.content_part.done', {
    fields: [strField('item_id'), fOutputIndex, fContentIndex, fPart],
  }),

  // --- function-call arguments (discrete — see file header) -------------------
  event('response.function_call_arguments.delta', {
    fields: [strField('item_id')],
    data: { encode: (c) => c.delta, decode: (d) => ({ delta: asString(d) }) },
  }),
  event('response.function_call_arguments.done', {
    fields: [strField('item_id'), strField('name')],
    data: { encode: (c) => c.arguments, decode: (d) => ({ arguments: asString(d) }) },
  }),
];

export const inputs = ({ event }: InputBuilder<OpenAIInput>): readonly InputDescriptor<OpenAIInput>[] => [
  // The client-published tool result. user-message is folded directly in the
  // spike (no wire encode), so it is intentionally absent from this table.
  event('tool-result', {
    fields: [strField('callId')],
    data: { encode: (p) => p.output, decode: (d) => ({ output: asString(d) }) },
  }),
];
