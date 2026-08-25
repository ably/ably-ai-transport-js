/**
 * Type-level tests: the Vercel wrappers thread the AI SDK's `UIMessage` generic
 * parameters (metadata / data parts / tools) end to end, so a consumer that
 * supplies concrete types gets them back from the codec's unions and the
 * chat-transport surface rather than the SDK defaults (`metadata: unknown`).
 *
 * The assertions are checked by `pnpm run typecheck` (which includes `test/`);
 * the runtime bodies keep the cases live under `pnpm test`.
 */

import type * as AI from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { WireCodec } from '../../src/core/codec/types.js';
import { createUIMessageCodec, type VercelInput, type VercelOutput } from '../../src/vercel/index.js';
import { type ChatTransport, createChatTransport } from '../../src/vercel/transport/chat-transport.js';

interface MyMetadata {
  userId: string;
}
// Intersect with the SDK base so these satisfy the `extends AI.UIDataTypes` /
// `extends AI.UITools` constraints (a plain interface has no implicit index
// signature and would not be assignable to `Record<string, …>`).
type MyDataParts = AI.UIDataTypes & { chart: { points: number[] } };
type MyTools = AI.UITools & { getWeather: { input: { city: string }; output: { tempC: number } } };
type MyMessage = AI.UIMessage<MyMetadata, MyDataParts, MyTools>;

describe('Vercel UIMessage generic threading', () => {
  it('createUIMessageCodec threads the message type into the input union', () => {
    const codec = createUIMessageCodec<MyMetadata, MyDataParts, MyTools>();

    // The codec's encoder accepts the consumer's typed message input.
    type Input = Parameters<ReturnType<typeof codec.createEncoder>['publishInput']>[0];
    expectTypeOf<Extract<Input, { kind: 'message' }>['payload']>().toEqualTypeOf<MyMessage>();
    expect(codec.createDecoder()).toBeDefined();
  });

  it('createChatTransport preserves the message type', () => {
    expectTypeOf(createChatTransport<MyMetadata, MyDataParts, MyTools>).returns.toEqualTypeOf<
      ChatTransport<MyMetadata, MyDataParts, MyTools>
    >();
    // sendMessages accepts the typed message list.
    expectTypeOf<
      Parameters<ChatTransport<MyMetadata, MyDataParts, MyTools>['sendMessages']>[0]['messages']
    >().toEqualTypeOf<MyMessage[]>();
  });

  it('the codec factory with no type arguments falls back to the SDK defaults', () => {
    // Passing no type parameters preserves today's inference — the codec
    // resolves to the all-defaults instantiation (bare VercelInput/Output).
    expectTypeOf(createUIMessageCodec()).toEqualTypeOf<WireCodec<VercelInput, VercelOutput>>();
  });
});
