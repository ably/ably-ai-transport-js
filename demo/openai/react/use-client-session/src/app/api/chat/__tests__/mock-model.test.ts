import { describe, it, expect } from 'vitest';
import type { Responses } from 'openai/resources/responses/responses';

import { createMockResponseStream } from '../mock-model';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

function userInput(text: string): Responses.ResponseInputItem[] {
  return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
}

async function drain(stream: ReadableStream<ResponseStreamEvent>): Promise<ResponseStreamEvent[]> {
  const out: ResponseStreamEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

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
