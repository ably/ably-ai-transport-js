/**
 * Shared test fixtures for the OpenAI Responses codec: minimal Response/item
 * builders, Responses stream-event builders, the encoder header-stamp hook, the
 * reducer-meta reader, and an offline encode→wire→decode bridge. Imported by the
 * reducer, roundtrip, and integration tests so the event shapes live in one place.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/index.js';
import type { OpenAIOutput, OpenAITurn } from '../../../src/openai/codec/index.js';
import { getTransportHeaders } from '../../../src/utils.js';

// --- minimal domain objects --------------------------------------------------

// CAST: tests read only `status` (and `error.message` on failure); the rest of
// Response is irrelevant, so a minimal stub stands in for the full shape.
export const minimalResponse = (
  status: Responses.ResponseStatus,
  error?: { code: string; message: string },
): Responses.Response =>
  ({ id: 'resp_1', status, ...(error === undefined ? {} : { error }) }) as unknown as Responses.Response;

export const messageItem = (
  id: string,
  content: Responses.ResponseOutputMessage['content'] = [],
): Responses.ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content,
});

export const functionCallItem = (
  id: string,
  callId: string,
  name: string,
  args = '',
  status: Responses.ResponseFunctionToolCall['status'] = 'in_progress',
): Responses.ResponseFunctionToolCall => ({
  id,
  type: 'function_call',
  call_id: callId,
  name,
  arguments: args,
  status,
});

// Internal helper for functionCallOutputEvent; the FunctionCallOutput item.
const functionCallOutput = (callId: string, output: string): Responses.ResponseInputItem.FunctionCallOutput => ({
  type: 'function_call_output',
  call_id: callId,
  output,
});

// The codec's own output event carrying a server-executed tool's result.
export const functionCallOutputEvent = (callId: string, output: string): OpenAIOutput => ({
  type: 'function_call_output',
  item: functionCallOutput(callId, output),
});

// --- Responses stream-event builders -----------------------------------------

export const created = (): Responses.ResponseStreamEvent => ({
  type: 'response.created',
  response: minimalResponse('in_progress'),
  sequence_number: 0,
});
export const inProgress = (): Responses.ResponseStreamEvent => ({
  type: 'response.in_progress',
  response: minimalResponse('in_progress'),
  sequence_number: 0,
});
export const queued = (): Responses.ResponseStreamEvent => ({
  type: 'response.queued',
  response: minimalResponse('queued'),
  sequence_number: 0,
});
export const completed = (): Responses.ResponseStreamEvent => ({
  type: 'response.completed',
  response: minimalResponse('completed'),
  sequence_number: 0,
});
export const incomplete = (): Responses.ResponseStreamEvent => ({
  type: 'response.incomplete',
  response: minimalResponse('incomplete'),
  sequence_number: 0,
});
export const failed = (message = 'boom'): Responses.ResponseStreamEvent => ({
  type: 'response.failed',
  response: minimalResponse('failed', { code: 'server_error', message }),
  sequence_number: 0,
});

// CAST: the reducer reads only `message`; code/param are omitted from this stub.
export const streamError = (message = 'rate limited'): Responses.ResponseStreamEvent =>
  ({ type: 'error', message, sequence_number: 0 }) as unknown as Responses.ResponseStreamEvent;

export const itemAdded = (item: Responses.ResponseOutputItem, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.output_item.added',
  item,
  output_index: outputIndex,
  sequence_number: 0,
});
export const itemDone = (item: Responses.ResponseOutputItem, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.output_item.done',
  item,
  output_index: outputIndex,
  sequence_number: 0,
});
export const contentPartAdded = (itemId: string, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.content_part.added',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  part: { type: 'output_text', text: '', annotations: [] },
  sequence_number: 0,
});
export const contentPartDone = (itemId: string, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.content_part.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  part: { type: 'output_text', text: '', annotations: [] },
  sequence_number: 0,
});
export const textDelta = (itemId: string, delta: string, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.output_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  delta,
  logprobs: [],
  sequence_number: 0,
});
export const textDone = (itemId: string, text: string, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.output_text.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  text,
  logprobs: [],
  sequence_number: 0,
});

export const reasoningItem = (
  id: string,
  summary: Responses.ResponseReasoningItem['summary'] = [],
): Responses.ResponseReasoningItem => ({
  id,
  type: 'reasoning',
  summary,
});

export const reasoningSummaryPartAdded = (
  itemId: string,
  summaryIndex = 0,
  text = '',
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.reasoning_summary_part.added',
  item_id: itemId,
  output_index: outputIndex,
  summary_index: summaryIndex,
  part: { type: 'summary_text', text },
  sequence_number: 0,
});
export const reasoningSummaryTextDelta = (
  itemId: string,
  delta: string,
  summaryIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.reasoning_summary_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  summary_index: summaryIndex,
  delta,
  sequence_number: 0,
});
export const reasoningSummaryTextDone = (
  itemId: string,
  text: string,
  summaryIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.reasoning_summary_text.done',
  item_id: itemId,
  output_index: outputIndex,
  summary_index: summaryIndex,
  text,
  sequence_number: 0,
});

/**
 * A reasoning item that streams one summary part: item added → part added →
 * deltas → summary text done → item done.
 * @param itemId - The reasoning item / stream id.
 * @param text - The final summary text.
 * @returns The ordered event stream.
 */
export const reasoningSummaryRun = (itemId: string, text: string): Responses.ResponseStreamEvent[] => {
  const fragments = ['Think', 'ing…'];
  return [
    itemAdded(reasoningItem(itemId)),
    reasoningSummaryPartAdded(itemId, 0),
    ...fragments.map((f) => reasoningSummaryTextDelta(itemId, f, 0)),
    reasoningSummaryTextDone(itemId, text, 0),
    itemDone(reasoningItem(itemId, [{ type: 'summary_text', text }])),
  ];
};

/**
 * A full streamed-text response: created → item → content part → deltas →
 * text done → item done → completed.
 * @param itemId - The message item / stream id.
 * @param text - The final text.
 * @returns The ordered event stream.
 */
export const textRun = (itemId: string, text: string): Responses.ResponseStreamEvent[] => {
  const item = messageItem(itemId);
  const fragments = ['Hello, ', 'world!'];
  return [
    created(),
    itemAdded(item),
    contentPartAdded(itemId),
    ...fragments.map((f) => textDelta(itemId, f)),
    textDone(itemId, text),
    itemDone(messageItem(itemId, [{ type: 'output_text', text, annotations: [] }])),
    completed(),
  ];
};

// A plain-text user turn: one input message with a single `input_text` part.
export const userTurn = (text: string): OpenAITurn => ({
  role: 'user',
  items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
});

// The first `input_text` part's text from a (user) turn, or '' if absent.
export const firstInputText = (turn: OpenAITurn | undefined): string => {
  const message = turn?.items.find((i): i is Responses.ResponseInputItem.Message => i.type === 'message');
  const part = message?.content.find((p) => p.type === 'input_text');
  return part?.type === 'input_text' ? part.text : '';
};

// --- transport-header helpers ------------------------------------------------

/**
 * An encoder `onMessage` hook that stamps run-id and codec-message-id on every
 * outgoing message.
 * @param runId - The run id to stamp.
 * @param messageId - The codec-message-id to stamp.
 * @returns The onMessage hook.
 */
export const stampHeaders =
  (runId: string, messageId: string) =>
  (msg: Ably.Message): void => {
    const transport = (msg.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
    if (transport) {
      transport[HEADER_RUN_ID] = runId;
      transport[HEADER_CODEC_MESSAGE_ID] = messageId;
    }
  };

/**
 * Build the reducer meta for an inbound message.
 * @param msg - The inbound message.
 * @returns The serial and optional codec-message-id.
 */
export const metaOf = (msg: Ably.InboundMessage): { serial: string; messageId?: string } => {
  const messageId = getTransportHeaders(msg)[HEADER_CODEC_MESSAGE_ID];
  return messageId === undefined ? { serial: msg.serial ?? '' } : { serial: msg.serial ?? '', messageId };
};

// --- offline wire bridge -----------------------------------------------------

interface Recorded {
  action: 'message.create' | 'message.append';
  serial: string;
  versionSerial: string;
  name: string | undefined;
  data: unknown;
  extras: unknown;
}

/**
 * A mock `ChannelWriter` that records publish/append operations and replays the
 * `InboundMessage` sequence a subscriber would see — for an offline
 * encode→decode roundtrip without a network.
 * @returns The writer and an `inbound()` accessor for the reconstructed messages.
 */
export const createBridge = (): { writer: ChannelWriter; inbound: () => Ably.InboundMessage[] } => {
  const recorded: Recorded[] = [];
  let serials = 0;
  let versions = 0;
  const writer: ChannelWriter = {
    // A batch publishes an array in one call; record each message as its own
    // create with its own serial (the wire `name` distinguishes input/output).
    publish: async (message) => {
      const msgs = Array.isArray(message) ? message : [message];
      const out: string[] = [];
      for (const msg of msgs) {
        const serial = `serial-${String((serials += 1))}`;
        recorded.push({
          action: 'message.create',
          serial,
          versionSerial: serial,
          name: msg.name,
          data: msg.data,
          extras: msg.extras,
        });
        out.push(serial);
      }
      return await Promise.resolve({ serials: out });
    },
    appendMessage: async (message) => {
      recorded.push({
        action: 'message.append',
        serial: message.serial ?? '',
        versionSerial: `v${String((versions += 1)).padStart(7, '0')}`,
        name: message.name,
        data: message.data,
        extras: message.extras,
      });
      // CAST: a minimal UpdateDeleteResult — the encoder ignores its shape.
      return await Promise.resolve({} as Ably.UpdateDeleteResult);
    },
    // CAST: minimal UpdateDeleteResult — unused on the happy path (no append failures).
    updateMessage: async () => await Promise.resolve({} as Ably.UpdateDeleteResult),
  };
  return {
    writer,
    inbound: () =>
      // CAST: the bridge reconstructs the minimal InboundMessage shape the decoder
      // reads (action / serial / version / name / data / extras).
      recorded.map(
        (r) =>
          ({
            action: r.action,
            serial: r.serial,
            version: { serial: r.versionSerial },
            name: r.name ?? '',
            data: r.data,
            extras: r.extras,
          }) as unknown as Ably.InboundMessage,
      ),
  };
};
