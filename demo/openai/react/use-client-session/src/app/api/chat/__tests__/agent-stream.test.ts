import type { Responses } from 'openai/resources/responses/responses';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createAgentStream } from '../agent-stream';
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

describe('createAgentStream', () => {
  it('streams a plain text reply with no tool calls', async () => {
    const events = await drain(
      createAgentStream({ input: userInput('Say "hi" as your reply'), signal: new AbortController().signal }),
    );
    expect(events.some((e) => e.type === 'function_call_output')).toBe(false);
    const done = events.find((e) => e.type === 'response.output_text.done');
    expect(done?.type === 'response.output_text.done' ? done.text : '').toBe('hi');
  });

  it('runs the tool, emits its function_call_output, and continues to a text reply', async () => {
    const events = await drain(
      createAgentStream({ input: userInput("what's the weather in London?"), signal: new AbortController().signal }),
    );

    // The call rides the item envelopes; its output is the codec's own event.
    const call = events.find((e) => e.type === 'response.output_item.done' && e.item.type === 'function_call');
    expect(call).toBeDefined();

    const output = events.find((e) => e.type === 'function_call_output');
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

    // The call's output must precede the final text reply (loop ordering).
    const outputIdx = events.findIndex((e) => e.type === 'function_call_output');
    const textIdx = events.findIndex((e) => e.type === 'response.output_text.done');
    expect(outputIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(outputIdx);
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
    await drain(
      createAgentStream({
        input: userInput('think it through and tell me the weather in London'),
        signal: new AbortController().signal,
      }),
    );

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
    const events = await drain(
      createAgentStream({ input: userInput("what's the weather in London?"), signal: controller.signal }),
    );
    expect(events).toHaveLength(0);
  });
});
