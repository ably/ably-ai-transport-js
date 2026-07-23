/**
 * The OpenAI Responses codec is a *full* codec — its `TInput` carries every
 * client-driven tool input variant — so it guards that the `DefinedCodec` is
 * assignable to the generic `Codec` the transport requires (the assignment
 * `createAgentSession` / `createClientSession` perform internally). This holds
 * because the well-known tool factories are typed present only when `TInput`
 * carries the matching variant (see `DefinedCodecFactories`), and the codec's
 * `factories` builder exposes the full well-known factory set — so the codec
 * both promises the tool factories in its type and carries them at runtime. The
 * cast-free assignment below is the guard.
 */

import { describe, expect, it } from 'vitest';

import type { Codec } from '../../../src/core/codec/types.js';
import type { OpenAIInput, OpenAIMessage, OpenAIOutput } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import type { OpenAIProjection } from '../../../src/openai/codec/reducer.js';

describe('ResponsesCodec satisfies the generic Codec contract', () => {
  it('is assignable to Codec<OpenAIInput, …> without a cast, carrying every tool variant', () => {
    // The assertion is the assignment itself: a plain (cast-free) assignment
    // only compiles when the DefinedCodec conforms to Codec.
    const asCodec: Codec<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAIMessage> = ResponsesCodec;
    expect(typeof asCodec.createUserMessage).toBe('function');
    expect(typeof asCodec.createRegenerate).toBe('function');
    // The tool factories are present at runtime, not merely typed — OpenAIInput
    // carries each variant, so the codec builds a factory for each.
    expect(typeof asCodec.createToolResult).toBe('function');
    expect(typeof asCodec.createToolResultError).toBe('function');
    expect(typeof asCodec.createToolApprovalResponse).toBe('function');
  });
});
