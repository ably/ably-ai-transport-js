/**
 * AIT-742 Phase 0 spike — falsification suite for hypotheses 1–8.
 *
 * Each `describe` maps to one hypothesis in the brief. Disposable scratch.
 */

import { describe, expect, it } from 'vitest';

import { HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../src/constants.js';
import type { CodecEvent, ReducerMeta } from '../../src/core/codec/index.js';
import { toCodecEvents } from '../../src/core/codec/codec-event.js';
import { getTransportHeaders } from '../../src/utils.js';
import type * as Ably from 'ably';
import { OpenAIResponsesCodec } from './codec.js';
import type { OpenAIInput, OpenAIOutput, OpenAITurn } from './events.js';
import * as fx from './fixtures.js';
import { toRenderItems } from './pairing.js';
import { fold, getMessages, init, type OpenAIProjection } from './reducer.js';
import { openaiRunOutcome, toResponsesInput } from './to-responses-input.js';
import { createMockWriter, stampHeaders } from './wire-bridge.js';
import type { ResponseFunctionToolCall, ResponseOutputMessage } from 'openai/resources/responses/responses';

// --- helpers -----------------------------------------------------------------

/** Fold raw output events directly into a fresh projection (agent-side stream). */
const foldDirect = (events: OpenAIOutput[], messageId = 'run-1', into?: OpenAIProjection): OpenAIProjection => {
  let state = into ?? init();
  const meta: ReducerMeta = { serial: '', messageId };
  for (const event of events) {
    const ce: CodecEvent<OpenAIInput, OpenAIOutput> = { direction: 'output', event };
    state = fold(state, ce, meta);
  }
  return state;
};

/** Encode -> wire -> decode -> fold, returning both the inbound wire and the projection. */
const foldThroughWire = async (
  events: OpenAIOutput[],
  messageId = 'run-1',
): Promise<{ inbound: Ably.InboundMessage[]; projection: OpenAIProjection; decoded: OpenAIOutput[] }> => {
  const writer = createMockWriter();
  const encoder = OpenAIResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', messageId) });
  // Sequencing each publish keeps wire order deterministic (deltas append
  // fire-and-forget; create/close await).
  for (const event of events) await encoder.publishOutput(event);
  await encoder.close();
  const inbound = writer.inbound();

  const decoder = OpenAIResponsesCodec.createDecoder();
  let projection = init();
  const decoded: OpenAIOutput[] = [];
  for (const msg of inbound) {
    const d = decoder.decode(msg);
    decoded.push(...d.outputs);
    const meta: ReducerMeta = { serial: msg.serial ?? '', messageId };
    for (const ce of toCodecEvents(d)) projection = fold(projection, ce, meta);
  }
  return { inbound, projection, decoded };
};

const firstMessage = (p: OpenAIProjection): OpenAITurn | undefined => getMessages(p)[0]?.message;
const transportOf = (m: Ably.InboundMessage): Record<string, string> => getTransportHeaders(m);

// =============================================================================
// Hypothesis 1 — string-append fits the codec's string-only stream model.
// =============================================================================
describe('H1: string-append fits (text stream)', () => {
  it('streams text deltas as string appends and reconstructs the text', async () => {
    const writer = createMockWriter();
    const encoder = OpenAIResponsesCodec.createEncoder(writer, { onMessage: stampHeaders('run-x', 'run-1') });
    for (const event of fx.textRun('msg_1', 'Hello, world!')) await encoder.publishOutput(event);
    await encoder.close();
    const inbound = writer.inbound();

    // The text part is a streamed create (stream=true, status=streaming).
    const streamCreate = inbound.find((m) => m.action === 'message.create' && transportOf(m)[HEADER_STREAM] === 'true');
    expect(streamCreate).toBeDefined();
    expect(transportOf(streamCreate!)[HEADER_STATUS]).toBe('streaming');
    expect(transportOf(streamCreate!)[HEADER_STREAM_ID]).toBe('msg_1');

    // Deltas arrive as string appends on that serial; the closing append is complete.
    const appends = inbound.filter((m) => m.action === 'message.append' && m.serial === streamCreate!.serial);
    expect(appends.length).toBeGreaterThanOrEqual(3);
    expect(appends.every((m) => typeof m.data === 'string')).toBe(true);
    expect(appends.map((m) => m.data).join('')).toContain('Hello, world!');
    expect(appends.some((m) => transportOf(m)[HEADER_STATUS] === 'complete')).toBe(true);
  });

  it('round-trips the text item through decode + fold', async () => {
    const { decoded, projection } = await foldThroughWire(fx.textRun('msg_1', 'Hello, world!'));
    expect(decoded.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
      ]),
    );
    const turn = firstMessage(projection)!;
    const msg = turn.items.find((i): i is ResponseOutputMessage => i.type === 'message')!;
    const text = msg.content.find((p) => p.type === 'output_text');
    expect(text && text.type === 'output_text' ? text.text : '').toBe('Hello, world!');
  });
});

// =============================================================================
// Hypothesis 2 — one message per run; codec-message-id is a clean boundary.
// =============================================================================
describe('H2: one message per run (multiple /responses calls)', () => {
  it('folds two /responses calls in one run into a single message', () => {
    // Call 1: a tool call. Call 2 (after the tool ran): a text answer.
    let p = foldDirect(fx.toolCallRun('fc_1', 'call_1', 'get_weather', '{"location":"London"}'), 'run-7');
    p = foldDirect(fx.textRun('msg_2', 'It is sunny.'), 'run-7', p);

    const messages = getMessages(p);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.codecMessageId).toBe('run-7');

    const items = messages[0]!.message.items;
    expect(items.some((i) => i.type === 'function_call')).toBe(true);
    expect(items.some((i) => i.type === 'message')).toBe(true);
  });
});

// =============================================================================
// Hypothesis 3 — concurrent tool-call streams compose.
// =============================================================================
describe('H3: concurrent function calls compose', () => {
  it('reduces two interleaved concurrent function calls correctly (direct)', () => {
    const p = foldDirect(fx.concurrentToolCallsRun());
    const calls = getMessages(p)[0]!.message.items.filter(
      (i): i is ResponseFunctionToolCall => i.type === 'function_call',
    );
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.call_id === 'call_a')?.arguments).toBe('{"city":"SF"}');
    expect(calls.find((c) => c.call_id === 'call_b')?.arguments).toBe('{"tz":"PST"}');
  });

  it('composes the same through the wire (args are discrete events, not streams)', async () => {
    const { inbound, projection } = await foldThroughWire(fx.concurrentToolCallsRun());
    // Strain evidence: function-call arg deltas are discrete creates (stream=false),
    // NOT appends — they cannot use the single-idField stream model (see findings).
    const argCreates = inbound.filter(
      (m) =>
        m.action === 'message.create' &&
        transportOf(m)[HEADER_STREAM] === 'false' &&
        (m.data === '{"city":' || m.data === '{"tz":' || m.data === '"SF"}' || m.data === '"PST"}'),
    );
    expect(argCreates.length).toBeGreaterThanOrEqual(4);
    expect(inbound.some((m) => m.action === 'message.append')).toBe(false);

    const calls = getMessages(projection)[0]!.message.items.filter(
      (i): i is ResponseFunctionToolCall => i.type === 'function_call',
    );
    expect(calls).toHaveLength(2);
  });
});

// =============================================================================
// Hypothesis 4 — items render cleanly and the call_id pairing helper is pleasant.
// =============================================================================
describe('H4: items render + call_id pairing helper', () => {
  it('pairs a function_call with its function_call_output by call_id', () => {
    let p = foldDirect(fx.toolCallRun('fc_1', 'call_1', 'get_weather', '{"location":"London"}'), 'run-4');
    p = fold(
      p,
      {
        direction: 'input',
        event: { kind: 'tool-result', codecMessageId: 'run-4', payload: { callId: 'call_1', output: '{"tempC":18}' } },
      },
      { serial: '', messageId: 'run-4' },
    );

    const render = toRenderItems(getMessages(p)[0]!.message);
    const tool = render.find((r) => r.kind === 'tool');
    expect(tool?.kind).toBe('tool');
    if (tool?.kind === 'tool') {
      expect(tool.pair.name).toBe('get_weather');
      expect(tool.pair.arguments).toBe('{"location":"London"}');
      expect(tool.pair.output).toBe('{"tempC":18}');
    }
    // The result item is not rendered separately — it is attached to the call.
    expect(render.filter((r) => r.kind === 'tool')).toHaveLength(1);
  });

  it('renders a plain text turn as item render entries', () => {
    const p = foldDirect(fx.textRun('msg_1', 'Hi'));
    const render = toRenderItems(getMessages(p)[0]!.message);
    expect(render.every((r) => r.kind === 'item')).toBe(true);
  });
});

// =============================================================================
// Hypothesis 5 — toResponsesInput is near-identity and round-trips losslessly.
// =============================================================================
describe('H5: toResponsesInput is near-identity', () => {
  it('concatenates each turn’s items, passing output items through by identity', () => {
    // User turn (built via the well-known factory) + assistant turn (folded).
    const userTurn: OpenAITurn = {
      role: 'user',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather in London?' }] }],
    };
    const userInput = OpenAIResponsesCodec.createUserMessage(userTurn);
    expect(userInput.kind).toBe('user-message');

    let assistant = foldDirect(fx.toolCallRun('fc_1', 'call_1', 'get_weather', '{"location":"London"}'), 'run-5');
    assistant = fold(
      assistant,
      {
        direction: 'input',
        event: { kind: 'tool-result', codecMessageId: 'run-5', payload: { callId: 'call_1', output: '{"tempC":18}' } },
      },
      { serial: '', messageId: 'run-5' },
    );
    const assistantTurn = getMessages(assistant)[0]!.message;

    const turns = [userTurn, assistantTurn];
    const input = toResponsesInput(turns);

    // Lossless: every item appears in order; assistant output items are the SAME objects.
    expect(input).toHaveLength(userTurn.items.length + assistantTurn.items.length);
    for (const item of assistantTurn.items) expect(input).toContain(item);
    // The model input ends with a function_call + its function_call_output.
    expect(input.some((i) => i.type === 'function_call')).toBe(true);
    expect(input.some((i) => i.type === 'function_call_output')).toBe(true);
  });
});

// =============================================================================
// Hypothesis 6 — a client ToolResult appends to the suspended run on resume.
// =============================================================================
describe('H6: ToolResult appends to the suspended run (same runId)', () => {
  it('lands the function_call_output in the same message as the call', () => {
    const p = foldDirect(fx.toolCallRun('fc_1', 'call_1', 'get_weather', '{"location":"London"}'), 'run-6');
    const resumed = fold(
      p,
      {
        direction: 'input',
        event: { kind: 'tool-result', codecMessageId: 'run-6', payload: { callId: 'call_1', output: '{"tempC":18}' } },
      },
      { serial: '', messageId: 'run-6' },
    );

    const messages = getMessages(resumed);
    expect(messages).toHaveLength(1);
    const items = messages[0]!.message.items;
    const call = items.find((i): i is ResponseFunctionToolCall => i.type === 'function_call');
    const output = items.find((i) => i.type === 'function_call_output');
    expect(call?.call_id).toBe('call_1');
    expect(output && output.type === 'function_call_output' ? output.call_id : '').toBe('call_1');
  });
});

// =============================================================================
// Hypothesis 7 — the descriptor split holds (stream vs event; coarse status).
// =============================================================================
describe('H7: descriptor split holds', () => {
  it('assembled the codec (validateTables passed) with text=stream, lifecycle=discrete', () => {
    expect(typeof OpenAIResponsesCodec.createEncoder).toBe('function');
    expect(typeof OpenAIResponsesCodec.fold).toBe('function');
    expect(OpenAIResponsesCodec.adapterTag).toBe('openai-responses-spike');
  });

  it('carries coarse status only on the streamed family, not on discrete lifecycle', async () => {
    const { inbound } = await foldThroughWire(fx.textRun('msg_1', 'Hi'));
    const streamed = inbound.filter((m) => transportOf(m)[HEADER_STREAM] === 'true');
    const discrete = inbound.filter((m) => transportOf(m)[HEADER_STREAM] === 'false');
    // Streamed family carries a status header; discrete lifecycle/structural events do not.
    expect(streamed.every((m) => transportOf(m)[HEADER_STATUS] !== undefined)).toBe(true);
    expect(discrete.every((m) => transportOf(m)[HEADER_STATUS] === undefined)).toBe(true);
    expect(streamed.length).toBeGreaterThanOrEqual(1);
    expect(discrete.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Hypothesis 8 — errors land on run-end; reducer stays out; refusal is content.
// =============================================================================
describe('H8: error routing + refusal-as-content', () => {
  it('does not fold response.failed into items; openaiRunOutcome maps it to error', () => {
    const p = foldDirect(fx.failedRun('msg_f'));
    // The partial message survives; no error item was injected by the reducer.
    const items = getMessages(p)[0]?.message.items ?? [];
    expect(items.every((i) => i.type !== 'function_call_output')).toBe(true);
    expect(p.errorMessage).toBe('model overloaded');
    expect(openaiRunOutcome({ status: 'failed' })).toBe('error');
  });

  it('maps a stream-level error and abort correctly', () => {
    const p = foldDirect([fx.created(), fx.streamError('boom')]);
    expect(p.errorMessage).toBe('boom');
    expect(openaiRunOutcome({ errored: true })).toBe('error');
    expect(openaiRunOutcome({ aborted: true })).toBe('cancelled');
    expect(openaiRunOutcome({ pendingClientTool: true })).toBe('suspend');
    expect(openaiRunOutcome({ status: 'completed' })).toBe('complete');
  });

  it('folds a refusal as content, not an error', () => {
    const p = foldDirect(fx.refusalRun('msg_r', 'I cannot help with that.'));
    expect(p.errorMessage).toBeUndefined();
    const msg = getMessages(p)[0]!.message.items.find((i): i is ResponseOutputMessage => i.type === 'message')!;
    const refusal = msg.content.find((c) => c.type === 'refusal');
    expect(refusal && refusal.type === 'refusal' ? refusal.refusal : '').toBe('I cannot help with that.');
  });
});
