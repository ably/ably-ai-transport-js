import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { SessionOptions } from '../../../src/core/session/index.js';
import { createClientSession } from '../../../src/core/session/index.js';
import { DefaultTree } from '../../../src/core/tree/index.js';
import { DefaultView } from '../../../src/core/view/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, createMockRealtime } from '../../helper/mock-realtime.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

const makeLog = () => makeLogger({ logLevel: LogLevel.Silent });

const makeNode = (id: string, serial: string) => ({
  id,
  role: 'user' as const,
  clientId: 'client-1',
  runId: 'r-1',
  message: `msg:${id}`,
  serial,
});

describe('View', () => {
  describe('messages', () => {
    it('mirrors the tree messages live', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });

      tree.applyMessage(makeNode('a', '01'));
      tree.applyMessage(makeNode('b', '02'));

      expect(view.messages.map((n) => n.id)).toEqual(['a', 'b']);
    });
  });

  describe('subscribe', () => {
    it('fires when the underlying tree changes', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const handler = vi.fn();
      view.subscribe(handler);

      tree.applyMessage(makeNode('a', '01'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns an unsubscribe function that detaches the listener', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const handler = vi.fn();
      const unsubscribe = view.subscribe(handler);

      tree.applyMessage(makeNode('a', '01'));
      unsubscribe();
      tree.applyMessage(makeNode('b', '02'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('isolates exceptions in one subscriber from others', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const good = vi.fn();
      view.subscribe(() => {
        throw new Error('boom');
      });
      view.subscribe(good);

      tree.applyMessage(makeNode('a', '01'));

      expect(good).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('stops firing subscribers after close()', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const handler = vi.fn();
      view.subscribe(handler);

      view.close();
      tree.applyMessage(makeNode('a', '01'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });

      view.close();
      expect(() => {
        view.close();
      }).not.toThrow();
    });

    it('subscribe() after close returns a no-op unsubscribe', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      view.close();

      const unsubscribe = view.subscribe(vi.fn());

      expect(() => {
        unsubscribe();
      }).not.toThrow();
    });
  });
});

const headersOf = (message: Ably.Message): Record<string, string> => {
  // CAST: tests own the structure of `extras` they passed in.
  const extras = message.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
};

const makeClientSession = (clientId = 'alice') => {
  const channel = createMockChannel();
  const realtime = createMockRealtime(channel, { clientId });
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const options: SessionOptions<StubCodec> = {
    client: realtime,
    sessionName: 'session-1',
    codec: stubCodec,
    logger,
  };
  return { channel, realtime, options };
};

describe('ClientView.send', () => {
  it('publishes the run-start wire first then the message wire, sharing one runId', async () => {
    const { options, channel } = makeClientSession();
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    const run = await view.send('hello');

    // The new sequential model: one publish for run-start, one publish per
    // message — atomicity is intentionally dropped so the codec layer
    // doesn't need a buffer abstraction.
    expect(channel.publish).toHaveBeenCalledTimes(2);
    expect(channel.publishedBatches).toHaveLength(2);

    const runStartBatch = channel.publishedBatches[0] ?? [];
    expect(runStartBatch).toHaveLength(1);
    const [runStart] = runStartBatch;
    if (!runStart) throw new Error('expected run-start wire');
    expect(runStart.name).toBe(WireMessages.RunStart);
    expect(headersOf(runStart)[Headers.RunId]).toBe(run.id);

    const messageBatch = channel.publishedBatches[1] ?? [];
    expect(messageBatch).toHaveLength(1);
    const [message] = messageBatch;
    if (!message) throw new Error('expected message wire');
    expect(message.data).toBe('hello');
    expect(headersOf(message)[Headers.RunId]).toBe(run.id);
    expect(headersOf(message)[Headers.Role]).toBe('user');
    expect(typeof headersOf(message)[Headers.MessageId]).toBe('string');
  });

  it("returns a ClientRun whose status is 'active' and reflects the publishing connection's clientId", async () => {
    const { options } = makeClientSession('alice');
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    const run = await view.send('hello');

    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('alice');
    expect(typeof run.id).toBe('string');
    expect(run.id.length).toBeGreaterThan(0);
  });

  it('produces an Invocation that round-trips via toJSON/fromJSON', async () => {
    const { options, channel } = makeClientSession();
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    const run = await view.send('hello');
    const invocationJson = run.toInvocation().toJSON();

    expect(invocationJson.sessionName).toBe('session-1');
    expect(invocationJson.runId).toBe(run.id);

    // The message ID on the invocation matches the messageId attached to
    // the published message wire (the second of two publishes in the new
    // sequential model). Agents waiting for it can rely on the round-trip.
    const messageBatch = channel.publishedBatches[1] ?? [];
    const [message] = messageBatch;
    if (!message) throw new Error('expected the message wire');
    expect(invocationJson.messageId).toBe(headersOf(message)[Headers.MessageId]);
  });

  it('rejects with InvalidArgument when the realtime connection has no clientId', async () => {
    const { options } = makeClientSession('');
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    await expect(view.send('hello')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it("rejects with InvalidArgument when the realtime connection's clientId is the wildcard '*'", async () => {
    const { options } = makeClientSession('*');
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    await expect(view.send('hello')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('rejects with SessionClosed after the session has been closed', async () => {
    const { options } = makeClientSession();
    const session = createClientSession(options);
    const view = session.createView();
    await session.close();

    await expect(view.send('hello')).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('accepts an array of messages and publishes run-start then one batch per message with a unique msg-id', async () => {
    const { options, channel } = makeClientSession();
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    const run = await view.send(['one', 'two', 'three']);

    // 1 run-start publish + 1 publish per message in the new sequential model.
    expect(channel.publish).toHaveBeenCalledTimes(4);
    expect(channel.publishedBatches).toHaveLength(4);

    const runStartBatch = channel.publishedBatches[0] ?? [];
    const [runStart] = runStartBatch;
    if (!runStart) throw new Error('expected run-start at the head of the publishes');
    expect(runStart.name).toBe(WireMessages.RunStart);
    expect(headersOf(runStart)[Headers.RunId]).toBe(run.id);

    const messageBatches = channel.publishedBatches.slice(1);
    const messages = messageBatches.map((batch) => {
      expect(batch).toHaveLength(1);
      return batch[0];
    });
    // CAST: Ably.Message.data is typed any; this test produced strings.
    expect(messages.map((wire) => wire?.data as string)).toEqual(['one', 'two', 'three']);

    const ids = messages.map((wire) => (wire ? headersOf(wire)[Headers.MessageId] : undefined));
    expect(new Set(ids).size).toBe(3);
    for (const wire of messages) {
      if (!wire) throw new Error('expected one wire per published batch');
      expect(headersOf(wire)[Headers.RunId]).toBe(run.id);
    }
  });

  it("the run's invocation messageId points at the last message in the array", async () => {
    const { options, channel } = makeClientSession();
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    const run = await view.send(['first', 'last']);

    // Last batch is the last message wire (run-start + 2 messages = 3 batches).
    const lastBatch = channel.publishedBatches.at(-1) ?? [];
    const [lastWire] = lastBatch;
    if (!lastWire) throw new Error('expected the last wire message');
    const lastMessageId = headersOf(lastWire)[Headers.MessageId];

    expect(run.toInvocation().toJSON().messageId).toBe(lastMessageId);
  });

  it('rejects with InvalidArgument when the messages array is empty', async () => {
    const { options, channel } = makeClientSession();
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    await expect(view.send([])).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('does not write to the tree directly — runs and messages arrive via the decode loop', async () => {
    const { options, channel } = makeClientSession();
    const session = createClientSession(options);
    await session.connect();
    const view = session.createView();

    const run = await view.send('hello');

    // The publish was observed but no inbound has been simulated, so the
    // tree must remain empty until the decode loop processes the echo.
    expect(view.messages).toHaveLength(0);
    // The first published message is the run-start; reflecting it back through
    // the decode loop fills tree.runs without view.send doing it inline.
    const [runStart] = channel.publishedBatches[0] ?? [];
    if (!runStart) throw new Error('expected run-start in the published batch');
    channel.simulateMessage({
      ...runStart,
      serial: '01',
      clientId: 'alice',
    } as unknown as Ably.InboundMessage);

    expect(view.messages).toHaveLength(0);
    // Reach for the run state via the same internal accessor the session tests use.
    // CAST: phase 6 keeps `_tree` private on the session.
    const tree = (session as unknown as { _tree: { runs: readonly { id: string; status: string }[] } })._tree;
    expect(tree.runs.map((r) => r.id)).toEqual([run.id]);
  });
});
