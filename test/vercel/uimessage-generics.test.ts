/**
 * Type-level tests: the Vercel codec carries the AI SDK's `UIMessage` generic
 * parameters (metadata / data parts / tools) through to its event union, so a
 * consumer that supplies concrete types gets them back off `encode` and
 * `decode` rather than the SDK defaults (`metadata: unknown`).
 *
 * The assertions are checked by `pnpm run typecheck` (which includes `test/`).
 * The runtime bodies keep the cases live under `pnpm test`.
 */

import type * as AI from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createVercelCodec, type VercelEvent } from '../../src/vercel/index.js';

interface MyMetadata {
  userId: string;
}
// Intersect with the SDK base so these satisfy the `extends AI.UIDataTypes` /
// `extends AI.UITools` constraints (a plain interface has no implicit index
// signature and would not be assignable to `Record<string, …>`).
type MyDataParts = AI.UIDataTypes & { chart: { points: number[] } };
type MyTools = AI.UITools & { getWeather: { input: { city: string }; output: { tempC: number } } };
type MyMessage = AI.UIMessage<MyMetadata, MyDataParts, MyTools>;
type MyEvent = VercelEvent<MyMetadata, MyDataParts, MyTools>;

describe('Vercel UIMessage generic threading', () => {
  it('types the user message with the consumer’s message type', () => {
    const codec = createVercelCodec<MyMetadata, MyDataParts, MyTools>();
    type Input = Parameters<typeof codec.encode>[0];
    expectTypeOf<Extract<Input, { type: 'user-message' }>['message']>().toEqualTypeOf<MyMessage>();
    expect(codec).toBeDefined();
  });

  it('types the metadata on the lifecycle chunks decode returns', () => {
    const codec = createVercelCodec<MyMetadata, MyDataParts, MyTools>();
    type Output = ReturnType<typeof codec.decode>[number];
    expectTypeOf<Extract<Output, { type: 'start' }>['messageMetadata']>().toEqualTypeOf<MyMetadata | undefined>();
    expect(codec).toBeDefined();
  });

  it('types the user message’s metadata with the consumer’s metadata type', () => {
    expectTypeOf<Extract<MyEvent, { type: 'user-message' }>['message']['metadata']>().toEqualTypeOf<
      MyMetadata | undefined
    >();
    const message: MyMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    expect(message.id).toBe('m1');
  });
});
