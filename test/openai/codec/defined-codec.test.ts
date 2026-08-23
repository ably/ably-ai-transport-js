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

import type { Codec } from '../../../src/core/transport/session-codec.js';
import type { OpenAIMessage, OpenAIOutput } from '../../../src/openai/codec/index.js';
import type { OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import { ResponsesSessionCodec } from '../../../src/openai/codec/session-codec.js';
import type { OpenAISessionInput } from '../../../src/openai/codec/session-events.js';

describe('ResponsesSessionCodec satisfies the generic Codec contract', () => {
  it('is assignable to Codec<OpenAISessionInput, …> without a cast, carrying every tool variant', () => {
    // The assertion is the assignment itself: a plain (cast-free) assignment
    // only compiles when the DefinedCodec conforms to Codec.
    const asCodec: Codec<OpenAISessionInput, OpenAIOutput, OpenAIProjection, OpenAIMessage> = ResponsesSessionCodec;
    expect(typeof asCodec.createUserMessage).toBe('function');
    expect(typeof asCodec.createRegenerate).toBe('function');
    // The tool factories are present at runtime, not merely typed — OpenAISessionInput
    // carries each variant, so the codec builds a factory for each.
    expect(typeof asCodec.createToolResult).toBe('function');
    expect(typeof asCodec.createToolResultError).toBe('function');
    expect(typeof asCodec.createToolApprovalResponse).toBe('function');
  });
});
