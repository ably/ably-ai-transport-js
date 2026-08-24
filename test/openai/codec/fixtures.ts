/**
 * Shared test fixtures for the OpenAI Responses codec: minimal Response/item
 * builders, Responses stream-event builders, the encoder header-stamp hook, a
 * decoded-event filter, and an offline encode→wire→decode bridge. Imported by
 * the codec tests so the event shapes live in one place.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/index.js';
import type { OpenAIOutput } from '../../../src/openai/codec/index.js';

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

// An output item type the codec does not model, used to exercise the
// encode-boundary reject. computer_call_output is a
// ResponseOutputItem member whose output shape is not assignable to
// ResponseInputItem: the `status: 'failed'` here is a value the input variant
// rejects, so this is a genuine output-only item — not merely one the codec
// happens not to model.
export const computerCallOutputItem = (): Responses.ResponseComputerToolCallOutputItem => ({
  type: 'computer_call_output',
  id: 'cco_1',
  call_id: 'c1',
  output: { type: 'computer_screenshot' },
  status: 'failed',
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

// The codec's own output event gating a function call on a human decision.
export const toolApprovalRequestEvent = (callId: string, name: string, args: string): OpenAIOutput => ({
  type: 'tool-approval-request',
  call_id: callId,
  name,
  arguments: args,
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

// CAST: a minimal error-event stub — code/param are omitted; the codec drops
// the event at encode, so only `type` is ever read.
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
export const contentPartAdded = (itemId: string, contentIndex = 0, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.content_part.added',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
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
export const textDelta = (
  itemId: string,
  delta: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.output_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  delta,
  logprobs: [],
  sequence_number: 0,
});
export const textDone = (
  itemId: string,
  text: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.output_text.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  text,
  // logprobs are sourced from the finalised item (output_item.done) rather than
  // this event's wire form; empty here (the SDK type still requires the field).
  logprobs: [],
  sequence_number: 0,
});

// content_part.added opening a refusal / reasoning-text slot (the discriminated
// starts for the refusal / reasoning_text groups).
export const refusalPartAdded = (itemId: string, contentIndex = 0, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.content_part.added',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  part: { type: 'refusal', refusal: '' },
  sequence_number: 0,
});
export const refusalDelta = (
  itemId: string,
  delta: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.refusal.delta',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  delta,
  sequence_number: 0,
});
export const refusalDone = (
  itemId: string,
  refusal: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.refusal.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  refusal,
  sequence_number: 0,
});
export const reasoningTextPartAdded = (
  itemId: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.content_part.added',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  part: { type: 'reasoning_text', text: '' },
  sequence_number: 0,
});
export const reasoningTextDelta = (
  itemId: string,
  delta: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.reasoning_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  delta,
  sequence_number: 0,
});
export const reasoningTextDone = (
  itemId: string,
  text: string,
  contentIndex = 0,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.reasoning_text.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: contentIndex,
  text,
  sequence_number: 0,
});

export const reasoningItem = (
  id: string,
  summary: Responses.ResponseReasoningItem['summary'] = [],
  encryptedContent?: string,
): Responses.ResponseReasoningItem => ({
  id,
  type: 'reasoning',
  summary,
  ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
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
export const reasoningSummaryPartDone = (
  itemId: string,
  summaryIndex = 0,
  text = '',
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.reasoning_summary_part.done',
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

export const fnArgsDelta = (itemId: string, delta: string, outputIndex = 0): Responses.ResponseStreamEvent => ({
  type: 'response.function_call_arguments.delta',
  item_id: itemId,
  output_index: outputIndex,
  delta,
  sequence_number: 0,
});
export const fnArgsDone = (
  itemId: string,
  args: string,
  name: string,
  outputIndex = 0,
): Responses.ResponseStreamEvent => ({
  type: 'response.function_call_arguments.done',
  item_id: itemId,
  output_index: outputIndex,
  arguments: args,
  name,
  sequence_number: 0,
});

/**
 * A function call that streams its arguments: item added (args empty) → arg
 * deltas → arg done → item done (full args).
 * @param itemId - The function-call item / stream id.
 * @param callId - The call id (pairs with the tool output).
 * @param name - The function name.
 * @param args - The final arguments JSON string.
 * @returns The ordered event stream.
 */
export const functionCallArgsRun = (
  itemId: string,
  callId: string,
  name: string,
  args: string,
): Responses.ResponseStreamEvent[] => {
  const mid = Math.ceil(args.length / 2);
  return [
    itemAdded(functionCallItem(itemId, callId, name, '', 'in_progress')),
    fnArgsDelta(itemId, args.slice(0, mid)),
    fnArgsDelta(itemId, args.slice(mid)),
    fnArgsDone(itemId, args, name),
    itemDone(functionCallItem(itemId, callId, name, args, 'completed')),
  ];
};

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

// --- transport-header helpers ------------------------------------------------

/**
 * An encoder `onAblyMessage` hook that stamps run-id and codec-message-id on
 * every outgoing message.
 * @param runId - The run id to stamp.
 * @param messageId - The codec-message-id to stamp.
 * @returns The onAblyMessage hook.
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

// --- decoded-event helpers -----------------------------------------------------

/**
 * The decoded output events of one `type`, narrowed to that union member.
 * @param outputs - The decoded output events, in delivery order.
 * @param type - The event `type` literal to keep.
 * @returns The matching events, in order.
 */
export const eventsOfType = <T extends OpenAIOutput['type']>(
  outputs: OpenAIOutput[],
  type: T,
): Extract<OpenAIOutput, { type: T }>[] =>
  outputs.filter((o): o is Extract<OpenAIOutput, { type: T }> => o.type === type);

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
