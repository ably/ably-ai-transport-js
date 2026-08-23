/**
 * Type-level tests: the Vercel wrapper threads the AI SDK's `UIMessage` generic
 * parameters (metadata / data parts / tools) end to end, so a consumer that
 * supplies concrete types gets them back from `view.getMessages()` and the
 * chat/react surface rather than the SDK defaults (`metadata: unknown`).
 *
 * The assertions are checked by `pnpm run typecheck` (which includes `test/`);
 * they fail to compile against a non-generic wrapper — `createClientSession`
 * taking no type argument, or `getMessages` yielding `unknown` metadata. The
 * runtime bodies keep the cases live under `pnpm test`.
 */

import type * as AI from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { WireCodec } from '../../src/core/codec/types.js';
import type { CodecMessage, DefinedCodec } from '../../src/core/transport/session-codec.js';
import type { ClientSession } from '../../src/core/transport/types.js';
import { type VercelProjection } from '../../src/vercel/codec/reducer.js';
import { createUIMessageSessionCodec } from '../../src/vercel/codec/session-codec.js';
import type { VercelSessionInput } from '../../src/vercel/codec/session-events.js';
import {
  type ChatTransport,
  createChatTransport,
  createClientSession,
  createUIMessageCodec,
  type SendMessagesRequestContext,
  type VercelInput,
  type VercelOutput,
} from '../../src/vercel/index.js';
import type { UseMessagesWithSeedOptions, UseMessageSyncOptions } from '../../src/vercel/react/index.js';

interface MyMetadata {
  userId: string;
}
// Intersect with the SDK base so these satisfy the `extends AI.UIDataTypes` /
// `extends AI.UITools` constraints (a plain interface has no implicit index
// signature and would not be assignable to `Record<string, …>`).
type MyDataParts = AI.UIDataTypes & { chart: { points: number[] } };
type MyTools = AI.UITools & { getWeather: { input: { city: string }; output: { tempC: number } } };
type MyMessage = AI.UIMessage<MyMetadata, MyDataParts, MyTools>;

type MySession = ClientSession<
  VercelSessionInput<MyMetadata, MyDataParts, MyTools>,
  VercelOutput<MyMetadata, MyDataParts>,
  VercelProjection<MyMetadata, MyDataParts, MyTools>,
  MyMessage
>;

describe('Vercel UIMessage generic threading', () => {
  it('createUIMessageCodec threads the message type into the input union', () => {
    const codec = createUIMessageCodec<MyMetadata, MyDataParts, MyTools>();

    // The codec's encoder accepts the consumer's typed message input.
    type Input = Parameters<ReturnType<typeof codec.createEncoder>['publishInput']>[0];
    expectTypeOf<Extract<Input, { kind: 'message' }>['payload']>().toEqualTypeOf<MyMessage>();
    expect(codec.createDecoder()).toBeDefined();
  });

  it('createUIMessageSessionCodec threads the message type into getMessages and createUserMessage', () => {
    const codec = createUIMessageSessionCodec<MyMetadata, MyDataParts, MyTools>();

    // getMessages surfaces the consumer's typed message (metadata + data + tools).
    expectTypeOf<ReturnType<typeof codec.getMessages>>().toEqualTypeOf<CodecMessage<MyMessage>[]>();
    // createUserMessage accepts the consumer's typed message.
    expectTypeOf<Parameters<typeof codec.createUserMessage>[0]>().toEqualTypeOf<MyMessage>();

    // Runtime: the factory still wraps a message as a user-message input.
    const message: MyMessage = { id: 'u1', role: 'user', metadata: { userId: 'a' }, parts: [] };
    expect(codec.createUserMessage(message).kind).toBe('user-message');
  });

  it('createClientSession threads metadata/data/tools to view.getMessages (not widened to unknown)', () => {
    // Instantiation expression (not called) — proves createClientSession is generic
    // over the three UIMessage params and returns a session typed to the message.
    expectTypeOf(createClientSession<MyMetadata, MyDataParts, MyTools>).returns.toEqualTypeOf<MySession>();

    type Messages = ReturnType<MySession['view']['getMessages']>;
    expectTypeOf<Messages>().toEqualTypeOf<CodecMessage<MyMessage>[]>();
    // The headline fix: metadata carries the consumer's type, not `unknown`.
    expectTypeOf<Messages[number]['message']['metadata']>().toEqualTypeOf<MyMetadata | undefined>();
    expectTypeOf<Messages[number]['message']['metadata']>().not.toBeUnknown();
  });

  it('createChatTransport and its request context preserve the message type', () => {
    expectTypeOf(createChatTransport<MyMetadata, MyDataParts, MyTools>).returns.toEqualTypeOf<
      ChatTransport<MyMetadata, MyDataParts, MyTools>
    >();
    // The prepare-request context carries the typed history/messages.
    expectTypeOf<SendMessagesRequestContext<MyMetadata, MyDataParts, MyTools>['messages']>().toEqualTypeOf<
      MyMessage[]
    >();
  });

  it('the react imperative hooks preserve the message type', () => {
    expectTypeOf<UseMessageSyncOptions<MyMetadata, MyDataParts, MyTools>['messages']>().toEqualTypeOf<
      MyMessage[] | undefined
    >();
    expectTypeOf<UseMessagesWithSeedOptions<MyMetadata, MyDataParts, MyTools>['seed']>().toEqualTypeOf<MyMessage[]>();
    // The setMessages updater receives and returns the typed overlay.
    expectTypeOf<Parameters<UseMessageSyncOptions<MyMetadata, MyDataParts, MyTools>['setMessages']>[0]>()
      .parameter(0)
      .toEqualTypeOf<MyMessage[]>();
  });

  it('the codec factories with no type arguments fall back to the SDK defaults', () => {
    // Passing no type parameters preserves today's inference — each codec
    // resolves to the all-defaults instantiation (bare VercelInput/Output).
    expectTypeOf(createUIMessageCodec()).toEqualTypeOf<WireCodec<VercelInput, VercelOutput>>();
    expectTypeOf(createUIMessageSessionCodec()).toEqualTypeOf<
      DefinedCodec<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>
    >();
  });
});
