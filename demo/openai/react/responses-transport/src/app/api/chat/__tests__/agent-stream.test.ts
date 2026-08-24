import type { StreamResult } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIMessage } from '../../../lib/openai-thread';
import type { Responses } from 'openai/resources/responses/responses';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { runAgentLoop } from '../agent-stream';
import * as model from '../model';
import { drain, userInput } from './stream-helpers';

// The agentic loop drives createResponseStream, which uses the deterministic
// mock model behind MOCK_LLM — so these tests run the whole loop (model turn →
// tool execution → continuation) with no network.
beforeEach(() => {
  vi.stubEnv('MOCK_LLM', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * A stand-in for the run's publishing surface. Each `pipe` drains its stream
 * into its own message, mirroring the transport minting a fresh
 * `codec-message-id` per pipe — so `messages` holds one entry per unit of work
 * the loop published.
 */
function makeRun(signal: AbortSignal): {
  run: { abortSignal: AbortSignal; pipe: (source: AsyncIterable<OpenAIOutput>) => Promise<StreamResult> };
  messages: OpenAIOutput[][];
} {
  const messages: OpenAIOutput[][] = [];
  const run = {
    abortSignal: signal,
    pipe: async (source: AsyncIterable<OpenAIOutput>): Promise<StreamResult> => {
      messages.push(await drain(source));
      return { reason: 'complete' };
    },
  };
  return { run, messages };
}

describe('runAgentLoop', () => {
  it('publishes one message for a plain text reply with no tool calls', async () => {
    const { run, messages } = makeRun(new AbortController().signal);
    const result = await runAgentLoop({ run, input: userInput('Say "hi" as your reply'), priorMessages: [] });

    expect(result.reason).toBe('complete');
    // No tools → a single model turn → a single message.
    expect(messages).toHaveLength(1);
    const events = messages[0] ?? [];
    expect(events.some((e) => e.type === 'function_call_output')).toBe(false);
    const done = events.find((e) => e.type === 'response.output_text.done');
    expect(done?.type === 'response.output_text.done' ? done.text : '').toBe('hi');
  });

  it('publishes the tool call, its output, and the final reply as separate messages', async () => {
    const { run, messages } = makeRun(new AbortController().signal);
    await runAgentLoop({ run, input: userInput("what's the weather in London?"), priorMessages: [] });

    // Three messages: the turn that emitted the call, the tool outputs, the final turn.
    expect(messages).toHaveLength(3);
    const [callTurn, toolOutputs, finalTurn] = messages;

    // The call is carried by the item envelopes in the first message.
    const call = (callTurn ?? []).find(
      (e) => e.type === 'response.output_item.done' && e.item.type === 'function_call',
    );
    expect(call).toBeDefined();
    // Rule B: the function_call_output lands in its OWN message, not the call's.
    expect((callTurn ?? []).some((e) => e.type === 'function_call_output')).toBe(false);

    const output = (toolOutputs ?? []).find((e) => e.type === 'function_call_output');
    expect(output).toBeDefined();
    if (output?.type === 'function_call_output') {
      expect(output.item.call_id).toBeTruthy();
      // The server ran getWeather; its result carries the location and a temperature.
      const parsed = JSON.parse(typeof output.item.output === 'string' ? output.item.output : '{}') as {
        location?: string;
        temperature?: number;
      };
      expect(parsed.location).toBe('London');
      expect(typeof parsed.temperature).toBe('number');
    }

    // The final message carries the text reply.
    expect((finalTurn ?? []).some((e) => e.type === 'response.output_text.done')).toBe(true);
  });

  it('feeds the reasoning item back into the next turn alongside the call (not just the call)', async () => {
    // Snapshot each turn's input at call time. The loop mutates one `input`
    // array in place, so recording the reference would only show its final
    // state; clone on each call to capture the per-turn input. Delegate to the
    // real mock model so the loop runs unchanged.
    const realCreate = model.createResponseStream;
    const inputs: Responses.ResponseInputItem[][] = [];
    vi.spyOn(model, 'createResponseStream').mockImplementation((req) => {
      inputs.push(structuredClone(req.input));
      return realCreate(req);
    });
    const { run } = makeRun(new AbortController().signal);
    await runAgentLoop({
      run,
      input: userInput('think it through and tell me the weather in London'),
      priorMessages: [],
    });

    // Two model turns: the reasoning+tool turn, then the reply after the tool result.
    expect(inputs).toHaveLength(2);
    const secondInput = inputs[1] ?? [];
    const types = secondInput.map((i) => i.type);

    // The reasoning item precedes the function_call, which precedes its output.
    const reasoningIdx = types.indexOf('reasoning');
    const callIdx = types.indexOf('function_call');
    const outputIdx = types.indexOf('function_call_output');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(callIdx);
    expect(callIdx).toBeLessThan(outputIdx);
    // The call is fed back exactly once — not duplicated by the tool-output loop.
    expect(types.filter((t) => t === 'function_call')).toHaveLength(1);
  });

  it('emits a gated call and its approval request on ONE message, then suspends', async () => {
    const { run, messages } = makeRun(new AbortController().signal);
    const result = await runAgentLoop({
      run,
      input: userInput("what's the weather forecast for Paris?"),
      priorMessages: [],
    });

    // The gated call needs a human decision, so the run suspends after one turn.
    expect(result.reason).toBe('suspend');
    expect(messages).toHaveLength(1);
    const events = messages[0] ?? [];

    // The function_call and its approval request ride the SAME message. Their
    // shared codec-message-id is why the client's later approval-response — and
    // its pending/decided state — merge onto one message rather than stranding.
    // The full call — its name and call_id — rides the output_item.added
    // envelope (the function_call_arguments stream's opener); output_item.done
    // reduces to id/type/status, so read the correlation off `added`.
    const call = events.find((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    const request = events.find((e) => e.type === 'tool-approval-request');
    expect(
      call?.type === 'response.output_item.added' && call.item.type === 'function_call' ? call.item.name : '',
    ).toBe('getWeatherForecast');
    expect(request).toBeDefined();
    if (
      request?.type === 'tool-approval-request' &&
      call?.type === 'response.output_item.added' &&
      call.item.type === 'function_call'
    ) {
      expect(request.name).toBe('getWeatherForecast');
      expect(request.call_id).toBe(call.item.call_id);
    }
  });

  it('emits one gated call per place when a turn asks about two, and suspends once', async () => {
    const { run, messages } = makeRun(new AbortController().signal);
    const result = await runAgentLoop({
      run,
      input: userInput("what's the weather forecast for Paris and London?"),
      priorMessages: [],
    });

    // Both calls ride one model turn, so the run suspends once holding two
    // undecided calls — the case where resuming after a single approval would
    // send the model a function_call with no output.
    expect(result.reason).toBe('suspend');
    expect(messages).toHaveLength(1);
    const events = messages[0] ?? [];
    const calls = events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    const requests = events.filter((e) => e.type === 'tool-approval-request');
    expect(calls).toHaveLength(2);
    expect(requests).toHaveLength(2);
    // Distinct call_ids, so each decision addresses exactly one call.
    const callIds = requests.flatMap((e) => (e.type === 'tool-approval-request' ? [e.call_id] : []));
    expect(new Set(callIds).size).toBe(2);
  });

  it('runs every approved gated call server-side on resume, then replies', async () => {
    const gatedCall = (suffix: string, location: string): Responses.ResponseFunctionToolCall => ({
      id: `fc-${suffix}`,
      type: 'function_call',
      call_id: `call-${suffix}`,
      name: 'getWeatherForecast',
      arguments: JSON.stringify({ location }),
      status: 'completed',
    });
    const paris = gatedCall('paris', 'Paris');
    const london = gatedCall('london', 'London');
    // The hydrated conversation on resume: both gated calls approved, neither run
    // yet. The agent owes the model an output for each before the next turn.
    const priorMessages: OpenAIMessage[] = [
      {
        role: 'assistant',
        items: [paris, london],
        toolCallStates: { 'call-paris': { approval: 'approved' }, 'call-london': { approval: 'approved' } },
      },
    ];
    const { run, messages } = makeRun(new AbortController().signal);
    const result = await runAgentLoop({
      run,
      input: [...userInput("what's the weather forecast for Paris and London?"), paris, london],
      priorMessages,
    });

    expect(result.reason).toBe('complete');
    const outputs = (messages[0] ?? []).flatMap((e) => (e.type === 'function_call_output' ? [e.item.call_id] : []));
    expect(outputs).toEqual(['call-paris', 'call-london']);
    expect((messages[1] ?? []).some((e) => e.type === 'response.output_text.done')).toBe(true);
  });

  it('runs an approved gated call server-side on resume, then replies', async () => {
    const call: Responses.ResponseFunctionToolCall = {
      id: 'fc-forecast',
      type: 'function_call',
      call_id: 'call-forecast',
      name: 'getWeatherForecast',
      arguments: '{"location":"Paris, France"}',
      status: 'completed',
    };
    // The hydrated conversation on resume: the gated call the user just approved
    // (its function_call and approval state on one message), with no output yet.
    const priorMessages: OpenAIMessage[] = [
      { role: 'assistant', items: [call], toolCallStates: { 'call-forecast': { approval: 'approved' } } },
    ];
    const { run, messages } = makeRun(new AbortController().signal);
    const result = await runAgentLoop({
      run,
      input: [...userInput("what's the weather forecast for Paris?"), call],
      priorMessages,
    });

    expect(result.reason).toBe('complete');
    // First the approved call runs server-side (its output), then the reply.
    expect(messages).toHaveLength(2);
    const output = (messages[0] ?? []).find((e) => e.type === 'function_call_output');
    expect(output?.type === 'function_call_output' ? output.item.call_id : '').toBe('call-forecast');
    expect((messages[1] ?? []).some((e) => e.type === 'response.output_text.done')).toBe(true);
  });

  it('stops cleanly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, messages } = makeRun(controller.signal);
    await runAgentLoop({ run, input: userInput("what's the weather in London?"), priorMessages: [] });
    // Aborted before the first pipe → nothing published.
    expect(messages).toHaveLength(0);
  });
});
