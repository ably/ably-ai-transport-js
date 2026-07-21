/**
 * The OpenAI Responses codec is a *partial* codec — its `TInput` omits the tool
 * input variants — so it guards that a partial `DefinedCodec` is assignable to
 * the generic `Codec` the transport requires (the assignment
 * `createAgentSession` / `createClientSession` perform internally). This holds
 * because the well-known tool factories are typed present only when `TInput`
 * carries the matching variant (see `DefinedCodecFactories`), and the codec's
 * `factories` builder exposes only the two mandatory factories — so the codec
 * neither over-promises the tool factories in its type nor carries them at
 * runtime. The cast-free assignment below is the guard.
 */

import { describe, expect, it } from 'vitest';

import type { Codec } from '../../../src/core/codec/types.js';
import type { OpenAIInput, OpenAIMessage, OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import type { OpenAIProjection } from '../../../src/openai/codec/reducer.js';

describe('ResponsesCodec satisfies the generic Codec contract', () => {
  it('is assignable to Codec<OpenAIInput, …> without a cast, despite omitting the tool variants', () => {
    // The assertion is the assignment itself: a plain (cast-free) assignment
    // only compiles when the partial DefinedCodec conforms to Codec.
    const asCodec: Codec<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAIMessage> = ResponsesCodec;
    expect(typeof asCodec.createUserMessage).toBe('function');
    expect(typeof asCodec.createRegenerate).toBe('function');
    // The unsupported tool factories are absent at runtime, not merely hidden
    // by the type — the codec never builds a factory its TInput cannot represent.
    expect(typeof asCodec.createToolResult).toBe('undefined');
    expect(typeof asCodec.createToolResultError).toBe('undefined');
    expect(typeof asCodec.createToolApprovalResponse).toBe('undefined');
  });
});
