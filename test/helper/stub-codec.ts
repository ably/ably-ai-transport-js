import type * as Ably from 'ably';

import type { Accumulator, Codec, DecodedValue, Decoder, Encoder } from '../../src/core/codec/index.js';

/**
 * Trivial part type for the stub codec — each inbound carries a single
 * payload string used both as the streaming part and the assembled message.
 */
export type StubPart = string;

/** Composed message type for the stub codec — same shape as the part. */
export type StubMessage = string;

/** Auxiliary event type — stub codec doesn't emit events. */
export type StubEvent = never;

/** Codec type alias for tests that need to name `C` explicitly. */
export type StubCodec = Codec<StubPart, StubMessage>;

const stubDecoder: Decoder<StubPart> = {
  decode: (message: Ably.InboundMessage): DecodedValue<StubPart, StubEvent>[] => {
    if (typeof message.data !== 'string') {
      return [];
    }
    return [{ kind: 'part', part: message.data }];
  },
};

const createStubAccumulator = (): Accumulator<StubPart, StubMessage> => {
  const messages = new Map<string, StubMessage>();
  return {
    processPart: (part: StubPart, messageId?: string): void => {
      if (messageId === undefined) {
        return;
      }
      messages.set(messageId, part);
    },
    // Stub codec has no event type; the interface still requires the method.
    applyEvent: (): void => {
      // no-op
    },
    getMessage: (messageId: string): StubMessage | undefined => messages.get(messageId),
    setMessage: (messageId: string, message: StubMessage): void => {
      messages.set(messageId, message);
    },
    // Stub codec has no streaming state to finalize.
    completeMessage: (): void => {
      // no-op
    },
  };
};

const createStubEncoder = (): Encoder<StubPart> => ({
  encodePart: (part: StubPart): Ably.Message[] => [{ name: 'x-ably-message', data: part }],
  encodeEvent: (): Ably.Message[] => {
    throw new Error('stubCodec.encodeEvent not implemented — events land in a later phase');
  },
  close: (): Ably.Message[] => [],
});

/**
 * Stub codec for unit and integration tests.
 *
 * - `decode` returns `{ kind: 'part', part: msg.data }` when `data` is a
 *   string — the SDK falls back to the inbound's `x-ably-msg-id` header
 *   for routing, so the codec doesn't need to set `messageId` itself.
 * - `createAccumulator` records the most recent part as the message keyed
 *   by `messageId` and replays it from `getMessage`.
 * - `createEncoder` emits one Ably wire message per part (data = part).
 *   `encodeEvent` still throws — events land in a later phase.
 */
export const stubCodec: StubCodec = {
  createDecoder: () => stubDecoder,
  createAccumulator: () => createStubAccumulator(),
  createEncoder: () => createStubEncoder(),
};
