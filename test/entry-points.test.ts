/**
 * Guards the codec each public entry point publishes.
 *
 * Every entry point ships one codec per provider: a wire codec that encodes and
 * decodes, and nothing more. A consumer handed a codec missing `createEncoder`
 * or `createDecoder` fails at whichever call site first reaches for it, so the
 * mistake surfaces far from its cause — the codec suites cannot catch it
 * because they import the internal modules directly and never exercise the
 * entry points.
 *
 * The negative half pins the wire-only property: the codec owns the wire
 * format and folds no conversation state, so a reducer or projection surface
 * appearing on it is a layering regression, not a feature.
 *
 * The type-level half matters as much as the runtime half: a caller has to be
 * able to *name* the codec's event types to annotate their own state. Each test
 * below spells those types on a local, so dropping the type export breaks the
 * build here rather than in a consumer's.
 */

import { describe, expect, it } from 'vitest';

import type { ModelledOutputItem, OpenAIOutput } from '../src/openai/index.js';
import { ResponsesCodec } from '../src/openai/index.js';
import type { VercelInput, VercelOutput } from '../src/vercel/index.js';
import { createUIMessageCodec } from '../src/vercel/index.js';

/** State-folding surface a wire codec must not carry. */
const REDUCER_SURFACE = [
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
  it('publishes a wire codec that encodes and decodes and folds no state', () => {
    const codec = createUIMessageCodec();

    expect(codec).toHaveProperty('createEncoder', expect.any(Function));
    expect(codec).toHaveProperty('createDecoder', expect.any(Function));
    for (const method of REDUCER_SURFACE) {
      expect(codec, `wire codec unexpectedly carries ${method}`).not.toHaveProperty(method);
    }
  });

  it('publishes the types a caller needs to name the codec events', () => {
    const inputs: VercelInput[] = [];
    const outputs: VercelOutput[] = [];

    expect(inputs).toEqual([]);
    expect(outputs).toEqual([]);
  });
});

describe('@ably/ai-transport/openai', () => {
  it('publishes a wire codec that encodes and decodes and folds no state', () => {
    expect(ResponsesCodec).toHaveProperty('createEncoder', expect.any(Function));
    expect(ResponsesCodec).toHaveProperty('createDecoder', expect.any(Function));
    for (const method of REDUCER_SURFACE) {
      expect(ResponsesCodec, `wire codec unexpectedly carries ${method}`).not.toHaveProperty(method);
    }
  });

  it('publishes the types a caller needs to name the codec events', () => {
    const outputs: OpenAIOutput[] = [];
    const items: ModelledOutputItem[] = [];

    expect(outputs).toEqual([]);
    expect(items).toEqual([]);
  });
});
