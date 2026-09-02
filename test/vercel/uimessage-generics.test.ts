/**
 * Type-level tests: the Vercel codec threads the AI SDK's `UIMessage` generic
 * parameters (metadata / data parts / tools) end to end, so a consumer that
 * supplies concrete types gets them back off the encoder and the decoder rather
 * than the SDK defaults (`metadata: unknown`).
 *
 * The assertions are checked by `pnpm run typecheck` (which includes `test/`);
 * they fail to compile against a non-generic codec — `createUIMessageCodec`
 * taking no type argument, or the decoder yielding `unknown` metadata. The
 * runtime bodies keep the cases live under `pnpm test`.
 */

import type * as AI from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { TransportEvent } from '../../src/core/transport/types.js';
import { createUIMessageCodec, type VercelInput, type VercelOutput } from '../../src/vercel/index.js';

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
  it('threads the message type into the encoder input union', () => {
    const codec = createUIMessageCodec<MyMetadata, MyDataParts, MyTools>();

    // The codec's encoder accepts the consumer's typed message input.
    type Input = Parameters<ReturnType<typeof codec.createEncoder>['publishInput']>[0];
    expectTypeOf<Extract<Input, { kind: 'message' }>['payload']>().toEqualTypeOf<MyMessage>();
    // Keeps the case live under `pnpm test`; the assertion above is the point.
    expect(codec).toBeDefined();
  });

  it('threads the metadata type onto the decoder output chunks', () => {
    const codec = createUIMessageCodec<MyMetadata, MyDataParts, MyTools>();

    type Output = ReturnType<ReturnType<typeof codec.createDecoder>['decode']>['outputs'][number];
    expectTypeOf<Extract<Output, { type: 'start' }>['messageMetadata']>().toEqualTypeOf<MyMetadata | undefined>();
    expect(codec).toBeDefined();
  });

  it('threads both unions through a transport event a consumer folds itself', () => {
    type Event = TransportEvent<VercelInput<MyMetadata, MyDataParts, MyTools>, VercelOutput<MyMetadata, MyDataParts>>;

    expectTypeOf<Extract<Event, { kind: 'message' }>['inputs']>().toEqualTypeOf<
      VercelInput<MyMetadata, MyDataParts, MyTools>[]
    >();
    expectTypeOf<Extract<Event, { kind: 'message' }>['outputs']>().toEqualTypeOf<
      VercelOutput<MyMetadata, MyDataParts>[]
    >();

    const message: MyMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    expect(message.id).toBe('m1');
  });
});
