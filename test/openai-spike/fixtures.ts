/**
 * AIT-742 Phase 0 spike — fixture Responses event streams.
 *
 * Deterministic, hand-built `ResponseStreamEvent[]` streams; no live API key,
 * no LLM calls. `seq` numbers are cosmetic (the reducer/transport never read
 * them). Response snapshots are minimal casts — only `status`/`error` matter.
 */

import type { OpenAIOutput } from './events.js';
import type { Response, ResponseFunctionToolCall, ResponseOutputMessage } from 'openai/resources/responses/responses';

let seq = 0;
const next = (): number => (seq += 1);

const makeResponse = (status: Response['status'], error?: Response['error']): Response =>
  // Minimal Response — the reducer only reads status/error.
  ({ id: 'resp_1', status, error: error ?? null, output: [] }) as unknown as Response;

const messageItem = (id: string): ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [],
});

const functionCallItem = (id: string, callId: string, name: string): ResponseFunctionToolCall => ({
  type: 'function_call',
  id,
  call_id: callId,
  name,
  arguments: '',
  status: 'in_progress',
});

// --- event constructors ------------------------------------------------------

export const created = (): OpenAIOutput => ({
  type: 'response.created',
  response: makeResponse('in_progress'),
  sequence_number: next(),
});
export const completed = (): OpenAIOutput => ({
  type: 'response.completed',
  response: makeResponse('completed'),
  sequence_number: next(),
});
export const failed = (message: string): OpenAIOutput => ({
  type: 'response.failed',
  response: makeResponse('failed', { code: 'server_error', message }),
  sequence_number: next(),
});
export const streamError = (message: string): OpenAIOutput => ({
  type: 'error',
  code: null,
  message,
  param: null,
  sequence_number: next(),
});

export const itemAdded = (
  item: ResponseOutputMessage | ResponseFunctionToolCall,
  outputIndex: number,
): OpenAIOutput => ({
  type: 'response.output_item.added',
  item,
  output_index: outputIndex,
  sequence_number: next(),
});
export const itemDone = (
  item: ResponseOutputMessage | ResponseFunctionToolCall,
  outputIndex: number,
): OpenAIOutput => ({
  type: 'response.output_item.done',
  item,
  output_index: outputIndex,
  sequence_number: next(),
});

export const contentPartAdded = (itemId: string, outputIndex: number): OpenAIOutput => ({
  type: 'response.content_part.added',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  part: { type: 'output_text', text: '', annotations: [] },
  sequence_number: next(),
});
export const textDelta = (itemId: string, outputIndex: number, delta: string): OpenAIOutput => ({
  type: 'response.output_text.delta',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  delta,
  logprobs: [],
  sequence_number: next(),
});
export const textDone = (itemId: string, outputIndex: number, text: string): OpenAIOutput => ({
  type: 'response.output_text.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  text,
  logprobs: [],
  sequence_number: next(),
});

export const refusalPartAdded = (itemId: string, outputIndex: number): OpenAIOutput => ({
  type: 'response.content_part.added',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  part: { type: 'refusal', refusal: '' },
  sequence_number: next(),
});
export const refusalDelta = (itemId: string, outputIndex: number, delta: string): OpenAIOutput => ({
  type: 'response.refusal.delta',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  delta,
  sequence_number: next(),
});
export const refusalDone = (itemId: string, outputIndex: number, refusal: string): OpenAIOutput => ({
  type: 'response.refusal.done',
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  refusal,
  sequence_number: next(),
});

export const fcArgsDelta = (itemId: string, outputIndex: number, delta: string): OpenAIOutput => ({
  type: 'response.function_call_arguments.delta',
  item_id: itemId,
  output_index: outputIndex,
  delta,
  sequence_number: next(),
});
export const fcArgsDone = (itemId: string, outputIndex: number, name: string, args: string): OpenAIOutput => ({
  type: 'response.function_call_arguments.done',
  item_id: itemId,
  output_index: outputIndex,
  name,
  arguments: args,
  sequence_number: next(),
});

export { functionCallItem, messageItem };

// --- composed streams --------------------------------------------------------

/** A plain streamed-text response. */
export const textRun = (itemId = 'msg_1', text = 'Hello, world!'): OpenAIOutput[] => {
  const item = messageItem(itemId);
  return [
    created(),
    itemAdded(item, 0),
    contentPartAdded(itemId, 0),
    textDelta(itemId, 0, 'Hello, '),
    textDelta(itemId, 0, 'world'),
    textDelta(itemId, 0, '!'),
    textDone(itemId, 0, text),
    itemDone({ ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }, 0),
    completed(),
  ];
};

/** A single function call with streamed arguments (leaves a pending tool). */
export const toolCallRun = (
  itemId = 'fc_1',
  callId = 'call_1',
  name = 'get_weather',
  args = '{"location":"London"}',
): OpenAIOutput[] => {
  const item = functionCallItem(itemId, callId, name);
  return [
    created(),
    itemAdded(item, 0),
    fcArgsDelta(itemId, 0, '{"location":'),
    fcArgsDelta(itemId, 0, '"London"}'),
    fcArgsDone(itemId, 0, name, args),
    itemDone({ ...item, status: 'completed', arguments: args }, 0),
    completed(),
  ];
};

/**
 * Two concurrent function calls in ONE response (output_index 0 and 1), with
 * interleaved argument deltas (hyp 3).
 */
export const concurrentToolCallsRun = (): OpenAIOutput[] => {
  const a = functionCallItem('fc_a', 'call_a', 'get_weather');
  const b = functionCallItem('fc_b', 'call_b', 'get_time');
  return [
    created(),
    itemAdded(a, 0),
    itemAdded(b, 1),
    fcArgsDelta('fc_a', 0, '{"city":'),
    fcArgsDelta('fc_b', 1, '{"tz":'),
    fcArgsDelta('fc_a', 0, '"SF"}'),
    fcArgsDelta('fc_b', 1, '"PST"}'),
    fcArgsDone('fc_a', 0, 'get_weather', '{"city":"SF"}'),
    fcArgsDone('fc_b', 1, 'get_time', '{"tz":"PST"}'),
    itemDone({ ...a, status: 'completed', arguments: '{"city":"SF"}' }, 0),
    itemDone({ ...b, status: 'completed', arguments: '{"tz":"PST"}' }, 1),
    completed(),
  ];
};

/** A model refusal (folds as content, not an error). */
export const refusalRun = (itemId = 'msg_r', text = 'I cannot help with that.'): OpenAIOutput[] => {
  const item = messageItem(itemId);
  return [
    created(),
    itemAdded(item, 0),
    refusalPartAdded(itemId, 0),
    refusalDelta(itemId, 0, 'I cannot '),
    refusalDelta(itemId, 0, 'help with that.'),
    refusalDone(itemId, 0, text),
    itemDone({ ...item, status: 'completed', content: [{ type: 'refusal', refusal: text }] }, 0),
    completed(),
  ];
};

/** A response that fails partway. */
export const failedRun = (itemId = 'msg_f'): OpenAIOutput[] => {
  const item = messageItem(itemId);
  return [
    created(),
    itemAdded(item, 0),
    contentPartAdded(itemId, 0),
    textDelta(itemId, 0, 'Partial'),
    failed('model overloaded'),
  ];
};
