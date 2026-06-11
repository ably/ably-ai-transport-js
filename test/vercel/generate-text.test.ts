import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { generateTextToUIMessageStream } from '../../src/vercel/generate-text.js';

// Drain a chunk stream to an array.
const drain = async (stream: ReadableStream<AI.UIMessageChunk>): Promise<AI.UIMessageChunk[]> => {
  const reader = stream.getReader();
  const chunks: AI.UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
};

// Build a minimal `generateText` result exercising only the fields the
// converter reads (`steps` and `finishReason`).
const makeResult = (
  steps: { content: unknown[] }[],
  finishReason: AI.FinishReason = 'stop',
): Parameters<typeof generateTextToUIMessageStream>[0] =>
  // CAST: test fixture — the converter reads only `steps` and `finishReason`.
  ({ steps, finishReason }) as unknown as Parameters<typeof generateTextToUIMessageStream>[0];

const typesOf = (chunks: AI.UIMessageChunk[]): string[] => chunks.map((c) => c.type);

describe('generateTextToUIMessageStream', () => {
  it('emits start / step / text triple / finish for a text-only result', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(makeResult([{ content: [{ type: 'text', text: 'Hello world' }] }])),
    );

    expect(typesOf(chunks)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
    expect(chunks.find((c) => c.type === 'text-delta')).toMatchObject({ delta: 'Hello world' });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
  });

  it('uses one shared stream id across a text block start/delta/end', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(makeResult([{ content: [{ type: 'text', text: 'hi' }] }])),
    );

    const ids = chunks
      .filter((c) => c.type === 'text-start' || c.type === 'text-delta' || c.type === 'text-end')
      // CAST: these three chunk variants all carry an `id`.
      .map((c) => (c as { id: string }).id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('emits a reasoning triple', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(makeResult([{ content: [{ type: 'reasoning', text: 'because' }] }])),
    );

    expect(typesOf(chunks)).toEqual([
      'start',
      'start-step',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'finish-step',
      'finish',
    ]);
    expect(chunks.find((c) => c.type === 'reasoning-delta')).toMatchObject({ delta: 'because' });
  });

  it('emits complete (non-streamed) tool input and output chunks', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(
        makeResult([
          {
            content: [
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'getWeather', input: { location: 'London' } },
              { type: 'tool-result', toolCallId: 'tc1', toolName: 'getWeather', output: { tempC: 20 } },
            ],
          },
        ]),
      ),
    );

    expect(typesOf(chunks)).toEqual([
      'start',
      'start-step',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'finish',
    ]);
    expect(chunks.find((c) => c.type === 'tool-input-available')).toMatchObject({
      toolCallId: 'tc1',
      toolName: 'getWeather',
      input: { location: 'London' },
    });
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 'tc1',
      output: { tempC: 20 },
    });
  });

  it('emits a tool-output-error for a tool-error part', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(
        makeResult([
          {
            content: [
              { type: 'tool-error', toolCallId: 'tc1', toolName: 'getWeather', input: {}, error: new Error('boom') },
            ],
          },
        ]),
      ),
    );

    expect(chunks.find((c) => c.type === 'tool-output-error')).toMatchObject({ toolCallId: 'tc1', errorText: 'boom' });
  });

  it('wraps each generation step in its own start-step/finish-step pair', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(
        makeResult([
          {
            content: [
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'getWeather', input: { location: 'London' } },
              { type: 'tool-result', toolCallId: 'tc1', toolName: 'getWeather', output: { tempC: 20 } },
            ],
          },
          { content: [{ type: 'text', text: "It's 20°C in London." }] },
        ]),
      ),
    );

    expect(typesOf(chunks)).toEqual([
      'start',
      'start-step',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
  });

  it('propagates the finishReason onto the trailing finish chunk', async () => {
    const chunks = await drain(generateTextToUIMessageStream(makeResult([{ content: [] }], 'tool-calls')));

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool-calls' });
  });

  it('extracts toolCallId and approvalId from a tool-approval-request part', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(
        makeResult([
          { content: [{ type: 'tool-approval-request', approvalId: 'ap1', toolCall: { toolCallId: 'tc1' } }] },
        ]),
      ),
    );

    expect(chunks.find((c) => c.type === 'tool-approval-request')).toMatchObject({
      toolCallId: 'tc1',
      approvalId: 'ap1',
    });
  });

  it('skips file and source parts (not yet converted)', async () => {
    const chunks = await drain(
      generateTextToUIMessageStream(
        makeResult([
          {
            content: [
              { type: 'file', file: { mediaType: 'image/png', base64: '', uint8Array: new Uint8Array() } },
              { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.com' },
            ],
          },
        ]),
      ),
    );

    expect(typesOf(chunks)).toEqual(['start', 'start-step', 'finish-step', 'finish']);
  });

  it('emits just start/finish when there are no steps', async () => {
    const chunks = await drain(generateTextToUIMessageStream(makeResult([])));

    expect(typesOf(chunks)).toEqual(['start', 'finish']);
  });
});
