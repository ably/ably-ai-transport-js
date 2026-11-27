import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { chunkOfModelStreamPart } from '../../../src/vercel/temporal/model-stream.js';
import { foldWithProviderReducer } from '../../helper/ui-message-fold.js';

const encoder = new TextEncoder();

/**
 * A model stream part as Temporal's AI SDK plugin publishes it: JSON, encoded to bytes.
 * @param part - The part.
 * @returns Its bytes.
 */
const bytesOf = (part: unknown): Uint8Array => encoder.encode(JSON.stringify(part));

const chunkOf = (part: unknown): AI.UIMessageChunk | undefined => chunkOfModelStreamPart(bytesOf(part));

const finishPart = {
  type: 'finish',
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  finishReason: { unified: 'stop', raw: 'stop' },
};

describe('chunkOfModelStreamPart', () => {
  it.each([
    [
      { type: 'text-start', id: 't', providerMetadata: { openai: { itemId: 'i' } } },
      { type: 'text-start', id: 't', providerMetadata: { openai: { itemId: 'i' } } },
    ],
    [
      { type: 'text-delta', id: 't', delta: 'Hel' },
      { type: 'text-delta', id: 't', delta: 'Hel' },
    ],
    [
      { type: 'text-end', id: 't' },
      { type: 'text-end', id: 't' },
    ],
    [
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-start', id: 'r' },
    ],
    [
      { type: 'reasoning-delta', id: 'r', delta: 'hmm' },
      { type: 'reasoning-delta', id: 'r', delta: 'hmm' },
    ],
    [
      { type: 'reasoning-end', id: 'r' },
      { type: 'reasoning-end', id: 'r' },
    ],
    [
      { type: 'tool-input-start', id: 'c1', toolName: 'weather', providerExecuted: true, title: 'Weather' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'weather', providerExecuted: true, title: 'Weather' },
    ],
    [
      { type: 'tool-input-delta', id: 'c1', delta: '{"city":' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"city":' },
    ],
    [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: '{"city":"London"}' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'weather', input: { city: 'London' } },
    ],
    [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'now', input: '' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'now', input: {} },
    ],
    [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'search', result: { hits: 2 }, providerExecuted: true },
      { type: 'tool-output-available', toolCallId: 'c1', output: { hits: 2 }, providerExecuted: true },
    ],
    [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'search', result: 'quota', isError: true },
      { type: 'tool-output-error', toolCallId: 'c1', errorText: 'quota' },
    ],
    [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'search', result: { code: 429 }, isError: true },
      { type: 'tool-output-error', toolCallId: 'c1', errorText: '{"code":429}' },
    ],
    [{ type: 'stream-start', warnings: [] }, { type: 'start-step' }],
    [finishPart, { type: 'finish-step' }],
    [
      { type: 'error', error: { message: 'secret provider detail' } },
      { type: 'error', errorText: 'An error occurred.' },
    ],
  ])('maps %j to the chunk toUIMessageStream gives', (part, chunk) => {
    expect(chunkOf(part)).toStrictEqual(chunk);
  });

  it('reports a tool call whose input is not JSON as a dynamic tool-input-error', () => {
    expect(chunkOf({ type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: '{bad' })).toMatchObject({
      type: 'tool-input-error',
      toolCallId: 'c1',
      toolName: 'weather',
      input: '{bad',
      dynamic: true,
      errorText: expect.stringContaining('Invalid input for tool weather') as unknown,
    });
  });

  it.each([
    { type: 'tool-input-end', id: 'c1' },
    { type: 'response-metadata', id: 'r1', modelId: 'm' },
    { type: 'raw', rawValue: {} },
    { type: 'ping' },
    { type: 'source', sourceType: 'url', id: 's', url: 'https://example.com' },
  ])('gives no chunk for %j, as the AI SDK gives none', (part) => {
    expect(chunkOf(part)).toBeUndefined();
  });

  it.each([{ type: 'file', mediaType: 'image/png', data: 'AAAA' }, { type: 'a-part-type-from-a-later-release' }])(
    'reports %j as having no row',
    (part) => {
      expect(() => chunkOf(part)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
        message: `unable to encode event; no row for type '${part.type}'`,
      });
      expect(() => chunkOf(part)).toThrow(expect.objectContaining({ detail: { reason: 'noRow', type: part.type } }));
    },
  );

  it.each([
    ['bytes that are not JSON', encoder.encode('{not json')],
    ['JSON that is not an object', bytesOf(['text-delta'])],
    ['a part with no type', bytesOf({ id: 't' })],
    ['a part lacking a field its chunk needs', bytesOf({ type: 'text-delta', id: 't' })],
  ])('throws a 400 InvalidArgument for %s', (_, bytes) => {
    expect(() => chunkOfModelStreamPart(bytes)).toThrowErrorInfo({ code: ErrorCode.InvalidArgument, statusCode: 400 });
  });

  it("gives a model call's parts as chunks the AI SDK's reducer folds into the reply", async () => {
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'r1', modelId: 'm' },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'The user said hi.' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Hello ' },
      { type: 'text-delta', id: 't', delta: 'there.' },
      { type: 'text-end', id: 't' },
      finishPart,
    ];
    const chunks = parts.map((part) => chunkOf(part)).filter((chunk) => chunk !== undefined);

    const message = await foldWithProviderReducer([
      { type: 'start', messageId: 'msg_1' },
      ...chunks,
      { type: 'finish', finishReason: 'stop' },
    ]);

    expect(message?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text).toBe('Hello there.');
    expect(message?.parts.find((p): p is AI.ReasoningUIPart => p.type === 'reasoning')?.text).toBe('The user said hi.');
  });
});
