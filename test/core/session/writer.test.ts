import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { SessionOptions, SessionWriter } from '../../../src/core/session/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
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

  it('every wire emitted from one encodeMessage call shares the same msg-id', async () => {
    // Codec whose encodeMessage emits two wires in one publishBatch call —
    // both should carry the writer's per-message x-ably-msg-id.
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const multiCodec: StubCodec = {
      ...stubCodec,
      createEncoder: (args) => ({
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejected-promise factory; no async work to await.
        encodePart: (): Promise<void> => Promise.reject(new Error('not used')),
        encodeMessage: async (message, options) => {
          await args.core.publishBatch(
            [
              { name: 'x-ably-message', data: `${message}:1` },
              { name: 'x-ably-message', data: `${message}:2` },
            ],
            { headers: options?.headers },
          );
        },
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejected-promise factory; no async work to await.
        encodeEvent: (): Promise<void> => Promise.reject(new Error('not used')),
        close: async () => {
          await args.core.close();
        },
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

  it('publishes nothing when encodeMessage emits no wires', async () => {
    // A codec whose encodeMessage is a no-op (e.g. dropped a chunk type it
    // doesn't handle yet) should leave the channel untouched without
    // tripping the writer.
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const emptyCodec: StubCodec = {
      ...stubCodec,
      createEncoder: (args) => ({
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejected-promise factory; no async work to await.
        encodePart: (): Promise<void> => Promise.reject(new Error('not used')),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- intentionally a no-op resolved promise.
        encodeMessage: (): Promise<void> => Promise.resolve(),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejected-promise factory; no async work to await.
        encodeEvent: (): Promise<void> => Promise.reject(new Error('not used')),
        close: async () => {
          await args.core.close();
        },
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

  it('passes codec-supplied headers through alongside the SDK headers', async () => {
    // Codec adds its own x-codec-flag header inside the call to
    // core.publishBatch; the writer's x-ably-* set should sit alongside
    // it on the wire.
    const channel = createMockChannel();
    const realtime = createMockRealtime(channel);
    const codecWithExtras: StubCodec = {
      ...stubCodec,
      createEncoder: (args) => ({
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejected-promise factory; no async work to await.
        encodePart: (): Promise<void> => Promise.reject(new Error('not used')),
        encodeMessage: async (message, options) => {
          const merged: Record<string, string> = { ...options?.headers, 'x-codec-flag': 'on' };
          await args.core.publishBatch([{ name: 'x-ably-message', data: message }], { headers: merged });
        },
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejected-promise factory; no async work to await.
        encodeEvent: (): Promise<void> => Promise.reject(new Error('not used')),
        close: async () => {
          await args.core.close();
        },
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
    expect(headers[Headers.Role]).toBe('user');
    expect(typeof headers[Headers.MessageId]).toBe('string');
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

  it('accepts an array of messages and publishes one batch per message with a unique msg-id', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.sendMessages({ messages: ['first', 'second', 'third'], runId: 'r-1' });

    // The new encoder routes each domain message through its own
    // `core.publishBatch`, so the writer issues one `channel.publish` per
    // message. Each batch carries a single wire under a unique msg-id.
    expect(channel.publish).toHaveBeenCalledTimes(3);
    expect(channel.publishedBatches).toHaveLength(3);
    const wires = channel.publishedBatches.map((batch) => {
      expect(batch).toHaveLength(1);
      return batch[0];
    });
    // CAST: Ably.Message.data is typed any; this test produced strings.
    expect(wires.map((wire) => wire?.data as string)).toEqual(['first', 'second', 'third']);

    const ids = wires.map((wire) => (wire ? headersOf(wire)[Headers.MessageId] : undefined));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id?.length).toBeGreaterThan(0);
    }

    for (const wire of wires) {
      if (!wire) throw new Error('expected one wire per published batch');
      expect(headersOf(wire)[Headers.RunId]).toBe('r-1');
      expect(headersOf(wire)[Headers.Role]).toBe('user');
    }
  });

  it('does not publish when the messages array is empty', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.sendMessages({ messages: [], runId: 'r-1' });

    expect(channel.publish).not.toHaveBeenCalled();
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

/**
 * `startStep` is intentionally not on the public {@link SessionWriter}
 * interface — it is driven by {@link DefaultStep.start} and reached for
 * tests via the underlying class. The cast mirrors the pattern used for
 * {@link DefaultSessionWriter.startRunWithMessages} elsewhere.
 * @param session A session whose writer to reach.
 * @returns A typed view of the writer's `startStep` method.
 */
const reachStartStep = (
  session: ReturnType<typeof createClientSession<StubCodec>>,
): ((options: { runId: string; stepId: string }) => Promise<void>) => {
  const internals = session as unknown as {
    writer: { startStep: (options: { runId: string; stepId: string }) => Promise<void> };
  };
  return internals.writer.startStep.bind(internals.writer);
};

/**
 * `endStep` is intentionally not on the public {@link SessionWriter}
 * interface — it is driven by {@link DefaultStep.end} and reached for tests
 * via the underlying class.
 * @param session A session whose writer to reach.
 * @returns A typed view of the writer's `endStep` method.
 */
const reachEndStep = (
  session: ReturnType<typeof createClientSession<StubCodec>>,
): ((options: { runId: string; stepId: string; status: 'complete' | 'failed' }) => Promise<void>) => {
  const internals = session as unknown as {
    writer: { endStep: (options: { runId: string; stepId: string; status: 'complete' | 'failed' }) => Promise<void> };
  };
  return internals.writer.endStep.bind(internals.writer);
};

describe('SessionWriter.startStep (internal)', () => {
  it('publishes one x-ably-step-start with run-id and step-id headers', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();
    const startStep = reachStartStep(session);

    await startStep({ runId: 'r-1', stepId: 's-1' });

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.publishedBatches).toHaveLength(1);
    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(1);
    const [wire] = batch;
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.StepStart);
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.StepId]).toBe('s-1');
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeSession();
    const session = createClientSession(options);
    const startStep = reachStartStep(session);
    await session.close();

    await expect(startStep({ runId: 'r-1', stepId: 's-1' })).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });
});

describe('SessionWriter.endStep (internal)', () => {
  it('publishes one x-ably-step-end with run-id, step-id, and status headers', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();
    const endStep = reachEndStep(session);

    await endStep({ runId: 'r-1', stepId: 's-1', status: 'complete' });

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(1);
    const [wire] = batch;
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.StepEnd);
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.StepId]).toBe('s-1');
    expect(headers[Headers.Status]).toBe('complete');
  });

  it("publishes status='failed' when supplied", async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();
    const endStep = reachEndStep(session);

    await endStep({ runId: 'r-1', stepId: 's-1', status: 'failed' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.Status]).toBe('failed');
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeSession();
    const session = createClientSession(options);
    const endStep = reachEndStep(session);
    await session.close();

    await expect(endStep({ runId: 'r-1', stepId: 's-1', status: 'complete' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionClosed,
    );
  });
});

describe('SessionWriter.endRun', () => {
  it('publishes one x-ably-run-end message with run-id and status headers', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.endRun({ runId: 'r-1', status: 'complete' });

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.publishedBatches).toHaveLength(1);
    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(1);
    const [wire] = batch;
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.RunEnd);
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.Status]).toBe('complete');
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeSession();
    const session = createClientSession(options);
    await session.close();

    await expect(session.writer.endRun({ runId: 'r-1', status: 'complete' })).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionClosed,
    );
  });

  it('marks the channel in use so close() detaches and releases it', async () => {
    const { options, channel, realtime } = makeSession();
    const session = createClientSession(options);
    // endRun is the only channel-touching call; connect() is intentionally
    // skipped so this proves the writer's mark-channel-in-use path.

    await session.writer.endRun({ runId: 'r-1', status: 'complete' });
    await session.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.detach).toHaveBeenCalledTimes(1);
    expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
  });

  it("publishes status='failed' when supplied", async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.endRun({ runId: 'r-1', status: 'failed' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    // CAST: tests own the structure of `extras` they passed in.
    const headers = (wire.extras as { headers: Record<string, string> }).headers;
    expect(headers[Headers.Status]).toBe('failed');
  });
});

describe('SessionWriter.abort', () => {
  it('publishes one x-ably-abort message with run-id, msg-id, and reason headers', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    const result = await session.writer.abort({ runId: 'r-1' });

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.publishedBatches).toHaveLength(1);
    const batch = channel.publishedBatches[0] ?? [];
    expect(batch).toHaveLength(1);
    const [wire] = batch;
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.Abort);
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.Reason]).toBe('aborted');
    expect(headers[Headers.ClientId]).toBeUndefined();
    expect(headers[Headers.MessageId]).toBeDefined();
    // Returned messageId matches the wire's stamped header.
    expect(result.messageId).toBe(headers[Headers.MessageId]);
  });

  it('attaches x-ably-client-id when supplied', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.abort({ runId: 'r-1', clientId: 'end-user-1' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.ClientId]).toBe('end-user-1');
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeSession();
    const session = createClientSession(options);
    await session.close();

    await expect(session.writer.abort({ runId: 'r-1' })).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('marks the channel in use so close() detaches and releases it', async () => {
    const { options, channel, realtime } = makeSession();
    const session = createClientSession(options);

    await session.writer.abort({ runId: 'r-1' });
    await session.close();

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.detach).toHaveBeenCalledTimes(1);
    expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
  });
});

describe('SessionWriter.retry', () => {
  it('publishes one x-ably-retry message with run-id, msg-id, and reason headers', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    const result = await session.writer.retry({ runId: 'r-1' });

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(wire.name).toBe(WireMessages.Retry);
    const headers = headersOf(wire);
    expect(headers[Headers.RunId]).toBe('r-1');
    expect(headers[Headers.Reason]).toBe('retry');
    expect(headers[Headers.MessageId]).toBeDefined();
    expect(headers[Headers.StepId]).toBeUndefined();
    expect(result.messageId).toBe(headers[Headers.MessageId]);
  });

  it('attaches x-ably-step-id for step-level retry', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.retry({ runId: 'r-1', stepId: 's-1' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.StepId]).toBe('s-1');
  });

  it('attaches x-ably-client-id when supplied', async () => {
    const { options, channel } = makeSession();
    const session = createClientSession(options);
    await session.connect();

    await session.writer.retry({ runId: 'r-1', clientId: 'end-user-1' });

    const [wire] = channel.publishedBatches[0] ?? [];
    if (!wire) throw new Error('expected one wire message');
    expect(headersOf(wire)[Headers.ClientId]).toBe('end-user-1');
  });

  it('throws SessionClosed after the session has been closed', async () => {
    const { options } = makeSession();
    const session = createClientSession(options);
    await session.close();

    await expect(session.writer.retry({ runId: 'r-1' })).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });
});
