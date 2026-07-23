import type { StreamResult } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
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
    const result = await runAgentLoop({ run, input: userInput('Say "hi" as your reply') });

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
    await runAgentLoop({ run, input: userInput("what's the weather in London?") });

    // Three messages: the turn that emitted the call, the tool outputs, the final turn.
    expect(messages).toHaveLength(3);
    const [callTurn, toolOutputs, finalTurn] = messages;

    // The call rides the item envelopes in the first message.
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
    await runAgentLoop({ run, input: userInput('think it through and tell me the weather in London') });

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

  it('stops cleanly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, messages } = makeRun(controller.signal);
    await runAgentLoop({ run, input: userInput("what's the weather in London?") });
    // Aborted before the first pipe → nothing published.
    expect(messages).toHaveLength(0);
  });
});
