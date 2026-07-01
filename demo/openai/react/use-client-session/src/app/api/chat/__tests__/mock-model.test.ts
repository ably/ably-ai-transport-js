import { describe, it, expect } from 'vitest';
import type { Responses } from 'openai/resources/responses/responses';

import { createMockResponseStream } from '../mock-model';
import { drain, userInput } from './stream-helpers';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

const finalText = (events: ResponseStreamEvent[]): string | undefined => {
  const done = events.find((e) => e.type === 'response.output_text.done');
  return done?.type === 'response.output_text.done' ? done.text : undefined;
};

describe('createMockResponseStream', () => {
  it('emits the message envelope, content part, and a closing output_item.done', async () => {
    const events = await drain(
      createMockResponseStream({ input: userInput('Say "ok" as your reply'), signal: new AbortController().signal }),
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('response.output_item.added');
    expect(types).toContain('response.content_part.added');
    expect(types).toContain('response.output_text.delta');
    expect(types.at(-1)).toBe('response.output_item.done');
  });

  it('scripts a `Say "X"` prompt to reply with X', async () => {
    const events = await drain(
      createMockResponseStream({ input: userInput('Say "hello" as your reply'), signal: new AbortController().signal }),
    );
    expect(finalText(events)).toBe('hello');
  });

  it('scripts a `the word X` prompt to reply with X', async () => {
    const events = await drain(
      createMockResponseStream({
        input: userInput('Reply with the word RED and nothing else'),
        signal: new AbortController().signal,
      }),
    );
    expect(finalText(events)).toBe('RED');
  });

  it('emits a getWeather function call for a weather prompt (no result yet)', async () => {
    const events = await drain(
      createMockResponseStream({
        input: userInput("what's the weather in London?"),
        signal: new AbortController().signal,
      }),
    );
    // A function call rides the item envelopes only — no text, no content part.
    expect(events.map((e) => e.type)).toEqual(['response.output_item.added', 'response.output_item.done']);
    const done = events.find((e) => e.type === 'response.output_item.done');
    const item = done?.type === 'response.output_item.done' ? done.item : undefined;
    expect(item?.type).toBe('function_call');
    if (item?.type === 'function_call') {
      expect(item.name).toBe('getWeather');
      expect(JSON.parse(item.arguments)).toEqual({ location: 'London' });
    }
  });

  it('defaults the getWeather location when the prompt names no place', async () => {
    const events = await drain(
      createMockResponseStream({ input: userInput("what's the weather?"), signal: new AbortController().signal }),
    );
    const done = events.find((e) => e.type === 'response.output_item.done');
    const item = done?.type === 'response.output_item.done' ? done.item : undefined;
    if (item?.type === 'function_call') {
      expect(JSON.parse(item.arguments)).toEqual({ location: 'London, UK' });
    } else {
      throw new Error('expected a function_call');
    }
  });

  it('replies with text once the weather tool result is in the input', async () => {
    const input: Responses.ResponseInputItem[] = [
      ...userInput("what's the weather in London?"),
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'getWeather',
        arguments: '{"location":"London"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'c1', output: '{"temperature":60}' },
    ];
    const events = await drain(createMockResponseStream({ input, signal: new AbortController().signal }));
    // The loop's second turn: a text reply, no further tool call.
    expect(events.some((e) => e.type === 'response.output_text.done')).toBe(true);
    expect(events.some((e) => e.type === 'response.output_item.done' && e.item.type === 'function_call')).toBe(false);
    expect(finalText(events)).toContain('London');
  });

  it('closes early without a text-done when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await drain(
      createMockResponseStream({
        input: userInput('Reply with a very long story about a dragon'),
        signal: controller.signal,
      }),
    );
    // The slow path checks the signal before the first delta, so it closes
    // after the envelope without ever emitting output_text.done.
    expect(events.some((e) => e.type === 'response.output_text.done')).toBe(false);
    expect(events.some((e) => e.type === 'response.output_item.done')).toBe(false);
  });
});
