/**
 * The OpenAI Responses codec is a *partial* codec — its `TInput` omits the tool
 * input variants — so it guards that a partial `DefinedCodec` is assignable to
 * the generic `Codec` the transport requires (the assignment
 * `createAgentSession` / `createClientSession` perform internally). This broke
 * until the well-known tool factories were typed conditional on `TInput` (see
 * `DefinedCodecFactories`); the cast-free assignment below is the guard.
 */

import { describe, expect, it } from 'vitest';

import type { Codec } from '../../../src/core/codec/types.js';
import type { OpenAIInput, OpenAIOutput, OpenAITurn } from '../../../src/openai/codec/index.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import type { OpenAIProjection } from '../../../src/openai/codec/reducer.js';

describe('ResponsesCodec satisfies the generic Codec contract', () => {
  it('is assignable to Codec<OpenAIInput, …> without a cast, despite omitting the tool variants', () => {
    // The assertion is the assignment itself: a plain (cast-free) assignment
    // only compiles when the partial DefinedCodec conforms to Codec.
    const asCodec: Codec<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAITurn> = ResponsesCodec;
    expect(typeof asCodec.createUserMessage).toBe('function');
    expect(typeof asCodec.createRegenerate).toBe('function');
  });
});
