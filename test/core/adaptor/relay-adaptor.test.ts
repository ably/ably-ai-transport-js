import * as Ably from '@ably/pubsub-core';
import { describe, expect, it } from 'vitest';

import type { MessageHeaders, RelayEvent } from '../../../src/core/adaptor/index.js';
import { createRelayAdaptor } from '../../../src/core/adaptor/index.js';
import { ENDS_FIELD } from '../../../src/core/wire.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel } from '../../helper/mock-channel.js';
import { createTestCodec, type TestEvent } from '../../helper/test-codec.js';

/** The handoff the relay passes when a route starts, and the one a checkpoint with no open stream carries. */
// eslint-disable-next-line unicorn/no-null -- the relay's contract names null for both
const NO_HANDOFF = null;

/**
 * Wrap an event as the relay hands it to an adaptor.
 * @param data - The event.
 * @param offset - Its offset in the Workflow Stream.
 * @returns The relay event.
 */
const relayed = (data: TestEvent, offset = 0): RelayEvent<TestEvent> => ({ topic: 'agent', offset, data });

/**
 * A value read back from workflow history: JSON, with no identity shared with what was stored.
 * @param value - The value the relay stored.
 * @returns A copy, as Temporal hands it back.
 */
const throughHistory = <T>(value: T): T => {
  // eslint-disable-next-line unicorn/prefer-structured-clone -- workflow history stores JSON, which structuredClone does not model
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  // CAST: a JSON round trip of a JSON value gives back the same shape.
  return parsed as T;
};

/**
 * The `extras.ai` a recorded message carries.
 * @param message - A message the mock channel recorded.
 * @returns Its `extras.ai`.
 */
const aiOf = (message: Ably.Message | undefined): Record<string, unknown> | undefined =>
  // CAST: Ably types `extras` as `any`; the test reads one key off it.
  (message?.extras as { ai?: Record<string, unknown> } | undefined)?.ai;

describe('createRelayAdaptor', () => {
  it('carries a stream that a checkpoint cuts on in the same message', async () => {
    const channel = createMockChannel();
    const factory = createRelayAdaptor(createTestCodec());

    const first = factory(channel, NO_HANDOFF);
    first.write(relayed({ type: 'text-start', id: 'a' }, 0));
    first.write(relayed({ type: 'text-delta', id: 'a', delta: 'Hel' }, 1));
    const checkpoint = await first.flush();

    expect(checkpoint).toEqual({ handoff: { streams: [{ key: 'a', serial: 'serial-2' }] } });

    const second = factory(channel, throughHistory(checkpoint.handoff));
    second.write(relayed({ type: 'text-delta', id: 'a', delta: 'lo' }, 2));
    second.write(relayed({ type: 'text-end', id: 'a' }, 3));
    const closed = await second.close();

    expect(channel.appendCalls.map((m): unknown[] => [m.serial, m.data])).toEqual([['serial-2', 'lo']]);
    expect(aiOf(channel.publishCalls.at(-1))?.[ENDS_FIELD]).toBe('serial-2');
    expect(closed).toEqual({ handoff: NO_HANDOFF });
  });

  it('returns a null handoff when no stream is open', async () => {
    const adaptor = createRelayAdaptor(createTestCodec())(createMockChannel(), NO_HANDOFF);
    adaptor.write(relayed({ type: 'note', text: 'hi' }));

    await expect(adaptor.flush()).resolves.toEqual({ handoff: NO_HANDOFF });
  });

  it('refuses a write after close', async () => {
    const adaptor = createRelayAdaptor(createTestCodec())(createMockChannel(), NO_HANDOFF);
    await adaptor.close();

    expect(() => {
      adaptor.write(relayed({ type: 'note', text: 'late' }));
    }).toThrowErrorInfoWithCode(ErrorCode.StreamClosed);
  });

  it('marks an event of a type the codec has no row for as one the relay skips, and carries on', async () => {
    const channel = createMockChannel();
    const adaptor = createRelayAdaptor(createTestCodec())(channel, NO_HANDOFF);
    // CAST: the relay does not check event data, so a source can publish anything.
    const unknown = { type: 'not-a-row' } as unknown as TestEvent;

    expect(() => {
      adaptor.write(relayed(unknown));
    }).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400, type: 'AblyRelayUnsupportedEvent' }),
    );
    adaptor.write(relayed({ type: 'note', text: 'hi' }, 1));
    await expect(adaptor.flush()).resolves.toEqual({ handoff: NO_HANDOFF });
    expect(channel.publishCalls).toHaveLength(1);
  });

  it('throws the error the codec throws, unmarked, for an event it cannot write for another reason', () => {
    const malformed = new Ably.ErrorInfo('unable to encode event; malformed', ErrorCode.InvalidArgument, 400);
    const codec = {
      ...createTestCodec(),
      encode: () => {
        throw malformed;
      },
    };
    const adaptor = createRelayAdaptor(codec)(createMockChannel(), NO_HANDOFF);
    const write = () => {
      adaptor.write(relayed({ type: 'note', text: 'hi' }));
    };

    expect(write).toThrow(malformed);
    expect(write).toThrow(expect.not.objectContaining({ type: 'AblyRelayUnsupportedEvent' }));
  });

  it("rejects flush with the channel's error after the channel refuses a publish", async () => {
    const channel = createMockChannel();
    const refused = new Ably.ErrorInfo('service unavailable', 50003, 503);
    channel.publish.mockRejectedValueOnce(refused);
    const adaptor = createRelayAdaptor(createTestCodec())(channel, NO_HANDOFF);
    adaptor.write(relayed({ type: 'note', text: 'hi' }));

    await expect(adaptor.flush()).rejects.toBe(refused);
  });

  it('aborts at once: a waiting flush rejects, nothing more is written, and a second abort does nothing', async () => {
    const channel = createMockChannel();
    const adaptor = createRelayAdaptor(createTestCodec())(channel, NO_HANDOFF);
    adaptor.write(relayed({ type: 'note', text: 'one' }));
    const flushed = adaptor.flush();
    adaptor.write(relayed({ type: 'note', text: 'two' }));

    adaptor.abort();
    adaptor.abort();

    await expect(flushed).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    expect(channel.publishCalls.map((m): unknown => m.data)).not.toContain('two');
  });

  it('does not throw from abort after the channel stopped it', async () => {
    const channel = createMockChannel();
    channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('service unavailable', 50003, 503));
    const adaptor = createRelayAdaptor(createTestCodec())(channel, NO_HANDOFF);
    adaptor.write(relayed({ type: 'note', text: 'hi' }));
    await expect(adaptor.flush()).rejects.toBeErrorInfoWithCode(50003);

    expect(() => {
      adaptor.abort();
    }).not.toThrow();
  });

  it('puts its headers on every message it publishes', async () => {
    const channel = createMockChannel();
    const adaptor = createRelayAdaptor(createTestCodec(), { headers: { route: 'chat' } })(channel, NO_HANDOFF);
    adaptor.write(relayed({ type: 'note', text: 'hi' }));
    await adaptor.flush();

    expect(channel.publishCalls[0]?.extras).toMatchObject({ headers: { route: 'chat' } });
  });

  it('throws InvalidArgument for a bad header when the factory is created', () => {
    // CAST: deliberately outside MessageHeaders to exercise the runtime check.
    const headers = { meta: { nested: true } } as unknown as MessageHeaders;

    expect(() => createRelayAdaptor(createTestCodec(), { headers })).toThrowErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
  });

  it('throws InvalidArgument for a handoff no relay adaptor returned', () => {
    const factory = createRelayAdaptor(createTestCodec());

    expect(() => factory(createMockChannel(), { streams: 'nope' })).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});
