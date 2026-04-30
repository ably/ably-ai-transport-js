import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { SessionOptions, SessionWriter } from '../../../src/core/session/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, createMockRealtime } from '../../helper/mock-realtime.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

const makeSession = () => {
  const channel = createMockChannel();
  const realtime = createMockRealtime(channel);
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const options: SessionOptions<StubCodec> = {
    client: realtime,
    sessionName: 'session-1',
    codec: stubCodec,
    logger,
  };
  return { options, realtime, channel };
};

const headersOf = (message: Ably.Message): Record<string, string> => {
  // CAST: tests own the structure of `extras` they passed in.
  const extras = message.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
};

describe('SessionWriter.sendMessages', () => {
  it('publishes a single wire message with x-ably-msg-id, role, and run-id headers', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.sendMessages({ messages: 'hello', runId: 'r-1' });

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.publishedBatches).toHaveLength(1);
    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(1);
    const [wire] = batch;
    if (!wire) throw new Error('expected one wire message');
    expect(wire.data).toBe('hello');
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.Role]).toBe('user');
    expect(typeof headers[Headers.MessageId]).toBe('string');
    expect(headers[Headers.MessageId]?.length).toBeGreaterThan(0);
    expect(headers[Headers.ClientId]).toBeUndefined();
  });

  it('attaches x-ably-client-id when an override clientId is supplied', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.sendMessages({ messages: 'hi', runId: 'r-1', clientId: 'end-user-1' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.ClientId]).toBe('end-user-1');
  });

  it('reuses one msg-id across every wire message produced for a single send', async () => {
    // Override the codec to emit two wire messages per encodePart so we can
    // verify the writer attaches the same msg-id to all of them.
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const multiCodec: StubCodec = {
      ...stubCodec,
      createEncoder: () => ({
        encodePart: (part) => [
          { name: 'x-ably-message', data: `${part}:1` },
          { name: 'x-ably-message', data: `${part}:2` },
        ],
        encodeEvent: () => {
          throw new Error('not used');
        },
        close: () => [],
      }),
    };
    const logger = makeLogger({ logLevel: LogLevel.Silent });
    const session = createClientSession({
      client: realtime,
      sessionName: 'session-1',
      codec: multiCodec,
      logger,
    });
    await session.connect();

    await session.writer.sendMessages({ messages: 'hello', runId: 'r-1' });

    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(2);
    const ids = batch.map((m) => headersOf(m)[Headers.MessageId]);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
  });

  it('flushes encoder.close() output alongside the encoded part', async () => {
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const codecWithCloseOutput: StubCodec = {
      ...stubCodec,
      createEncoder: () => ({
        encodePart: (part) => [{ name: 'x-ably-message', data: part }],
        encodeEvent: () => {
          throw new Error('not used');
        },
        close: () => [{ name: 'x-ably-message', data: 'closing' }],
      }),
    };
    const logger = makeLogger({ logLevel: LogLevel.Silent });
    const session = createClientSession({
      client: realtime,
      sessionName: 'session-1',
      codec: codecWithCloseOutput,
      logger,
    });
    await session.connect();

    await session.writer.sendMessages({ messages: 'hello', runId: 'r-1' });

    const batch = channel.publishedBatches[0] ?? [];
    // CAST: Ably.Message.data is typed `any`; this test produced strings.
    const dataValues = batch.map((m) => m.data as string);
    expect(dataValues).toEqual(['hello', 'closing']);
  });

  it('publishes nothing when the encoder produces no wire messages', async () => {
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const emptyCodec: StubCodec = {
      ...stubCodec,
      createEncoder: () => ({
        encodePart: () => [],
        encodeEvent: () => {
          throw new Error('not used');
        },
        close: () => [],
      }),
    };
    const logger = makeLogger({ logLevel: LogLevel.Silent });
    const session = createClientSession({
      client: realtime,
      sessionName: 'session-1',
      codec: emptyCodec,
      logger,
    });
    await session.connect();

    await session.writer.sendMessages({ messages: 'hello', runId: 'r-1' });

    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('preserves codec-supplied extras headers and overlays SDK headers on top', async () => {
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const codecWithExtras: StubCodec = {
      ...stubCodec,
      createEncoder: () => ({
        encodePart: (part) => [
          {
            name: 'x-ably-message',
            data: part,
            extras: { headers: { 'x-codec-flag': 'on' } },
          },
        ],
        encodeEvent: () => {
          throw new Error('not used');
        },
        close: () => [],
      }),
    };
    const logger = makeLogger({ logLevel: LogLevel.Silent });
    const session = createClientSession({
      client: realtime,
      sessionName: 'session-1',
      codec: codecWithExtras,
      logger,
    });
    await session.connect();

    await session.writer.sendMessages({ messages: 'hi', runId: 'r-1' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    const headers = headersOf(wire);
    expect(headers['x-codec-flag']).toBe('on');
    expect(headers[Headers.RunId]).toBe('r-1');
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeSession();
    const session = createClientSession(options);
    await session.close();

    await expect(session.writer.sendMessages({ messages: 'hi', runId: 'r-1' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionClosed,
    );
  });

  it('marks the channel in use so close() detaches and releases it', async () => {
    const { options, channel, realtime } = makeSession();
    const session = createClientSession(options);
    // Note: writer.sendMessages is the only channel-touching call; connect()
    // is intentionally skipped so this proves the writer's mark hook works.

    await session.writer.sendMessages({ messages: 'hi', runId: 'r-1' });
    await session.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.detach).toHaveBeenCalledTimes(1);
    expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
  });

  it('publishes x-ably-role=assistant when constructed via createAgentSession', async () => {
    const { options, channel } = makeSession();
    const session = createAgentSession(options);
    await session.connect();
    // The AgentSession interface omits `writer`; we reach into the class to
    // verify the role-mapping branch. Phase 7 will expose writer publicly on
    // AgentSession when it gains its own codec parameter.
    // CAST: AgentSession's runtime object has the writer; the public type
    //       intentionally hides it until phase 7.
    const writer = (session as unknown as { writer: SessionWriter<StubCodec> }).writer;

    await writer.sendMessages({ messages: 'agent-msg', runId: 'r-1' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Role]).toBe('assistant');
  });
});
