/**
 * Guards which codec tier each public entry point publishes.
 *
 * Every entry point ships two codecs per provider: a wire codec that encodes
 * and decodes, and a session codec that adds the reducer, the `getMessages`
 * projection read, and the well-known input factories. The sessions require the
 * session tier. A consumer handed the wrong one fails at whichever call site
 * first reaches for a missing method, so the mistake surfaces far from its
 * cause — the codec suites cannot catch it because they import the internal
 * modules directly and never exercise the entry points.
 *
 * The type-level half matters as much as the runtime half: a caller has to be
 * able to *name* `VercelProjection` / `OpenAIProjection` and the session input
 * unions to use `createSessionHooks` or to annotate a session. Each test below
 * spells those types on a local, so dropping the type export breaks the build
 * here rather than in a consumer's.
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { CodecMessage } from '../src/index.js';
import type { OpenAIMessage, OpenAIProjection, OpenAISessionInput } from '../src/openai/index.js';
import { ResponsesCodec, ResponsesSessionCodec } from '../src/openai/index.js';
import type { VercelProjection, VercelSessionInput } from '../src/vercel/index.js';
import { createUIMessageCodec, createUIMessageSessionCodec } from '../src/vercel/index.js';

/** The surface the sessions and the Tree call, and a wire codec does not carry. */
const SESSION_SURFACE = [
  'init',
  'fold',
  'getMessages',
  'createUserMessage',
  'createRegenerate',
  'createToolResult',
  'createToolResultError',
  'createToolApprovalResponse',
];

describe('@ably/ai-transport/vercel', () => {
  it('publishes a session codec carrying the reducer and the input factories', () => {
    const codec = createUIMessageSessionCodec();

    for (const method of SESSION_SURFACE) {
      expect(codec, `session codec is missing ${method}`).toHaveProperty(method, expect.any(Function));
    }
  });

  it('publishes a wire codec that encodes and decodes and carries none of the session surface', () => {
    const codec = createUIMessageCodec();

    expect(codec).toHaveProperty('createEncoder', expect.any(Function));
    expect(codec).toHaveProperty('createDecoder', expect.any(Function));
    for (const method of SESSION_SURFACE) {
      expect(codec, `wire codec unexpectedly carries ${method}`).not.toHaveProperty(method);
    }
  });

  it('publishes the types a caller needs to name a session', () => {
    const codec = createUIMessageSessionCodec();

    const projection: VercelProjection = codec.init();
    const input: VercelSessionInput = codec.createUserMessage({
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    });
    const messages: CodecMessage<AI.UIMessage>[] = codec.getMessages(projection);

    expect(input.kind).toBe('user-message');
    expect(messages).toEqual([]);
  });
});

describe('@ably/ai-transport/openai', () => {
  it('publishes a session codec carrying the reducer and the input factories', () => {
    for (const method of SESSION_SURFACE) {
      expect(ResponsesSessionCodec, `session codec is missing ${method}`).toHaveProperty(method, expect.any(Function));
    }
  });

  it('publishes a wire codec that encodes and decodes and carries none of the session surface', () => {
    expect(ResponsesCodec).toHaveProperty('createEncoder', expect.any(Function));
    expect(ResponsesCodec).toHaveProperty('createDecoder', expect.any(Function));
    for (const method of SESSION_SURFACE) {
      expect(ResponsesCodec, `wire codec unexpectedly carries ${method}`).not.toHaveProperty(method);
    }
  });

  it('publishes the types a caller needs to name a session', () => {
    const projection: OpenAIProjection = ResponsesSessionCodec.init();
    const input: OpenAISessionInput = ResponsesSessionCodec.createUserMessage({
      role: 'user',
      items: [],
    });
    const messages: CodecMessage<OpenAIMessage>[] = ResponsesSessionCodec.getMessages(projection);

    expect(input.kind).toBe('user-message');
    expect(messages).toEqual([]);
  });
});
