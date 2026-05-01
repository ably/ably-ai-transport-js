import type * as Ably from 'ably';

import type {
  Accumulator,
  Codec,
  CreateEncoderArgs,
  DecodedValue,
  Decoder,
  EncodeOptions,
  Encoder,
} from '../../src/core/codec/index.js';

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

const stubDecoder: Decoder<StubPart, StubMessage> = {
  decode: (message: Ably.InboundMessage): DecodedValue<StubPart, StubMessage, StubEvent>[] => {
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
    applyMessage: (messageId: string, message: StubMessage): void => {
      // Stub treats each apply as a replace — the codec produces complete
      // messages from single wires, so there's nothing to merge.
      messages.set(messageId, message);
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

/**
 * Construct the stub encoder. Each content-emitting method routes through
 * the supplied core's `publish` so the test path mirrors the real codec
 * — every wire goes through the same I/O surface a real codec would use.
 * @param args Wiring supplied by `Codec.createEncoder`.
 * @returns A stub encoder whose `encodePart`/`encodeMessage` publish a
 *   single wire and whose `encodeEvent` rejects (stub codec has no event
 *   type).
 */
const createStubEncoder = (args: CreateEncoderArgs): Encoder<StubPart, StubMessage> => ({
  encodePart: async (part: StubPart, options?: EncodeOptions): Promise<void> => {
    await args.core.publish({ name: 'x-ably-message', data: part }, { headers: options?.headers });
  },
  encodeMessage: async (message: StubMessage, options?: EncodeOptions): Promise<void> => {
    await args.core.publishBatch([{ name: 'x-ably-message', data: message }], { headers: options?.headers });
  },
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- intentional rejected-promise factory; no async work to await.
  encodeEvent: (): Promise<void> =>
    Promise.reject(new Error('stubCodec.encodeEvent not implemented — events land in a later phase')),
  close: async (): Promise<void> => {
    await args.core.close();
  },
});

/**
 * Stub codec for unit and integration tests.
 *
 * - `decode` returns `{ kind: 'part', part: msg.data }` when `data` is a
 *   string — the SDK falls back to the inbound's `x-ably-msg-id` header
 *   for routing, so the codec doesn't need to set `messageId` itself.
 * - `createAccumulator` records the most recent part as the message keyed
 *   by `messageId` and replays it from `getMessage`.
 * - `createEncoder` returns an encoder bound to the supplied core; every
 *   call publishes through `core.publish`/`core.publishBatch` so the
 *   stub mirrors the production codec layering.
 */
export const stubCodec: StubCodec = {
  createDecoder: () => stubDecoder,
  createAccumulator: () => createStubAccumulator(),
  createEncoder: (args) => createStubEncoder(args),
};
