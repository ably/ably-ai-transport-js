import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { Run } from '../../../src/core/run/index.js';
import type { SessionOptions } from '../../../src/core/session/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { VERSION } from '../../../src/version.js';
import {
  createMockChannel,
  createMockRealtime,
  type MockChannel,
  type MockRealtime,
} from '../../helper/mock-realtime.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

/**
 * Drive a channel state-change event from a previous state of 'attached'.
 * @param channel The mock channel.
 * @param current The new channel state.
 * @param reason Optional reason attached to the state change.
 */
const drive = (channel: MockChannel & Ably.RealtimeChannel, current: Ably.ChannelState, reason?: Ably.ErrorInfo) => {
  channel.simulateStateChange({
    current,
    previous: 'attached',
    resumed: false,
    reason,
  } as Ably.ChannelStateChange);
};

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

interface InboundOverrides {
  serial: string;
  msgId: string;
  role?: 'user' | 'assistant';
  clientId?: string;
  runId?: string;
  data?: unknown;
  extraHeaders?: Record<string, string>;
}

interface RunInboundOverrides {
  serial: string;
  name: string;
  headers: Record<string, string>;
  clientId?: string;
}

/**
 * Build an `Ably.InboundMessage` representing an SDK lifecycle wire message
 * (run-start / run-end). Tests pass this through
 * {@link MockChannel.simulateMessage} to drive the decode loop's run-event
 * branches.
 * @param overrides Wire message name, serial, headers, and optional clientId.
 * @returns A fully populated `Ably.InboundMessage`.
 */
const makeRunInbound = (overrides: RunInboundOverrides): Ably.InboundMessage =>
  ({
    id: `${overrides.name}:${overrides.serial}`,
    serial: overrides.serial,
    timestamp: Date.now(),
    action: 1,
    version: { serial: overrides.serial, timestamp: Date.now() },
    annotations: {},
    name: overrides.name,
    clientId: overrides.clientId,
    extras: { headers: overrides.headers },
  }) as unknown as Ably.InboundMessage;

/**
 * Reach into a session's private tree for tests that need to inspect run
 * state. The `tree` accessor is intentionally not on the public
 * `ClientSession`/`AgentSession` surfaces in phase 5 — it's deferred to a
 * later phase.
 * @param session A session created via `createClientSession`/`createAgentSession`.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<string> => {
  // CAST: phase 5 keeps `_tree` private; tests reach in via a structural cast
  // to assert decode-loop run state. The accessor will become public later.
  const internals = session as { _tree: Tree<string> };
  return internals._tree;
};

/**
 * Build an `Ably.InboundMessage` carrying the SDK headers Phase 2's decode
 * loop reads. Tests pass this through {@link MockChannel.simulateMessage}.
 * @param overrides Per-message values to project onto the inbound; everything
 *   else is filled with sensible defaults.
 * @returns A fully populated `Ably.InboundMessage`.
 */
const makeInbound = (overrides: InboundOverrides): Ably.InboundMessage => {
  const headers: Record<string, string> = {
    [Headers.MessageId]: overrides.msgId,
    [Headers.Role]: overrides.role ?? 'user',
    [Headers.RunId]: overrides.runId ?? 'r-1',
    ...overrides.extraHeaders,
  };
  if (overrides.clientId !== undefined) {
    headers[Headers.ClientId] = overrides.clientId;
  }
  return {
    id: overrides.msgId,
    serial: overrides.serial,
    timestamp: Date.now(),
    action: 1,
    version: { serial: overrides.serial, timestamp: Date.now() },
    annotations: {},
    name: 'x-ably-message',
    data: overrides.data ?? `payload:${overrides.msgId}`,
    extras: { headers },
  } as unknown as Ably.InboundMessage;
};

describe('Session', () => {
  describe('construction', () => {
    it('exposes sessionName from options', () => {
      const { options } = makeSession();
      const session = createClientSession(options);
      expect(session.sessionName).toBe('session-1');
    });

    it('registers the agent string on the realtime client', () => {
      const { options, realtime } = makeSession();
      createClientSession(options);
      expect(realtime.options.agents?.['ai-transport-js']).toBe(VERSION);
    });

    it('preserves agents already registered by the host application', () => {
      const { options, realtime } = makeSession();
      (realtime as MockRealtime).options.agents = { other: '1.2.3' };
      createClientSession(options);
      expect(realtime.options.agents?.other).toBe('1.2.3');
      expect(realtime.options.agents?.['ai-transport-js']).toBe(VERSION);
    });

    it('createAgentSession produces an equivalent session handle', () => {
      const { options } = makeSession();
      const session = createAgentSession(options);
      expect(session.sessionName).toBe('session-1');
    });

    it('does not fetch the channel until connect() is called', () => {
      const { options, realtime } = makeSession();
      createClientSession(options);
      expect(realtime.channels.get).not.toHaveBeenCalled();
    });
  });

  describe('connect()', () => {
    it('attaches the channel and registers a state listener', async () => {
      const { options, realtime, channel } = makeSession();
      const session = createClientSession(options);

      await session.connect();

      expect(realtime.channels.get).toHaveBeenCalledWith('session-1');
      expect(channel.attach).toHaveBeenCalledTimes(1);
      expect(channel.on).toHaveBeenCalledTimes(1);
      const [events] = channel.on.mock.calls[0] as [Ably.ChannelEvent[], Ably.channelEventCallback];
      expect(new Set(events)).toEqual(new Set<Ably.ChannelEvent>(['failed', 'detached']));
    });

    it('is idempotent — concurrent calls share a single attach', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);

      const a = session.connect();
      const b = session.connect();
      await Promise.all([a, b]);

      expect(channel.attach).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — sequential calls do not re-attach', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);

      await session.connect();
      await session.connect();

      expect(channel.attach).toHaveBeenCalledTimes(1);
    });

    it('clears the cached promise after a failed attach so retries can succeed', async () => {
      const { options, channel } = makeSession();
      const attachError = new Ably.ErrorInfo('attach failed', 90000, 500);
      channel.attach.mockRejectedValueOnce(attachError);
      const session = createClientSession(options);

      await expect(session.connect()).rejects.toBe(attachError);

      await session.connect();
      expect(channel.attach).toHaveBeenCalledTimes(2);
    });

    it('rejects if connect() is called after close()', async () => {
      const { options } = makeSession();
      const session = createClientSession(options);
      await session.close();

      await expect(session.connect()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });
  });

  describe('error events', () => {
    it('emits error when the channel transitions to failed', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      const reason = new Ably.ErrorInfo('boom', 50000, 500);
      drive(channel, 'failed', reason);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(reason);
    });

    it('emits error when the channel transitions to detached unexpectedly', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      const reason = new Ably.ErrorInfo('detached', 50000, 500);
      drive(channel, 'detached', reason);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(reason);
    });

    it('synthesises an error when the channel state change carries no reason', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      drive(channel, 'failed');

      expect(handler).toHaveBeenCalledTimes(1);
      const arg = handler.mock.calls[0]?.[0] as unknown;
      expect(arg).toBeErrorInfo({ code: ErrorCode.TransportSubscriptionError });
    });

    it('isolates exceptions thrown from one handler so others still fire', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const goodHandler = vi.fn();
      session.on('error', () => {
        throw new Error('handler exploded');
      });
      session.on('error', goodHandler);

      drive(channel, 'failed', new Ably.ErrorInfo('boom', 50000, 500));

      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it('off() removes a handler', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);
      session.off('error', handler);

      drive(channel, 'failed', new Ably.ErrorInfo('boom', 50000, 500));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('detaches the channel and releases it', async () => {
      const { options, channel, realtime } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session.close();

      expect(channel.detach).toHaveBeenCalledTimes(1);
      expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
    });

    it('removes the state listener before detach so close-induced state changes do not fire error', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      await session.close();
      // Simulate a detached event that might fire as part of the detach itself.
      channel.simulateStateChange({
        current: 'detached',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(handler).not.toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session.close();
      await session.close();

      expect(channel.detach).toHaveBeenCalledTimes(1);
    });

    it('does not reject when channel.detach() throws', async () => {
      const { options, channel } = makeSession();
      channel.detach.mockRejectedValueOnce(new Ably.ErrorInfo('detach failed', 90000, 500));
      const session = createClientSession(options);
      await session.connect();

      await expect(session.close()).resolves.toBeUndefined();
    });

    it('can be called before connect() with no side effects', async () => {
      const { options, channel, realtime } = makeSession();
      const session = createClientSession(options);

      await session.close();

      expect(channel.attach).not.toHaveBeenCalled();
      expect(realtime.channels.release).not.toHaveBeenCalled();
    });
  });

  describe('Symbol.asyncDispose', () => {
    it('is equivalent to close()', async () => {
      const { options, channel, realtime } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session[Symbol.asyncDispose]();

      expect(channel.detach).toHaveBeenCalledTimes(1);
      expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
    });
  });

  describe('createView()', () => {
    it('returns a view whose messages start empty', () => {
      const { options } = makeSession();
      const session = createClientSession(options);

      const view = session.createView();

      expect(view.messages).toEqual([]);
    });

    it('throws SessionClosed when called after close()', async () => {
      const { options } = makeSession();
      const session = createClientSession(options);
      await session.close();

      expect(() => session.createView()).toThrowErrorInfoWithCode(ErrorCode.SessionClosed);
    });

    it('closes outstanding views during session.close()', async () => {
      const { options } = makeSession();
      const session = createClientSession(options);
      const view = session.createView();
      const handler = vi.fn();
      view.subscribe(handler);

      await session.close();

      // After close the view is severed from the session — even if the session
      // were still pumping events into the tree, the view would not fire.
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not subscribe to the channel until connect()', () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);

      session.createView();

      expect(channel.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('decode loop', () => {
    it('subscribes to the channel after attach', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);

      await session.connect();

      expect(channel.subscribe).toHaveBeenCalledTimes(1);
    });

    it('produces a tree node for an inbound message and fires view subscribers', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();
      const handler = vi.fn();
      view.subscribe(handler);

      channel.simulateMessage(
        makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice', data: 'hello' }),
      );

      expect(view.messages).toHaveLength(1);
      expect(view.messages[0]).toEqual({
        id: 'm-1',
        role: 'user',
        clientId: 'alice',
        runId: 'r-1',
        serial: '01',
        message: 'hello',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('falls back to the publishing connection clientId when x-ably-client-id is absent', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();

      const inbound = makeInbound({ serial: '01', msgId: 'm-1', role: 'user', data: 'hello' });
      // CAST: editing the constructed mock to drop x-ably-client-id and add a connection-level clientId.
      (inbound as { clientId?: string }).clientId = 'conn-bob';
      channel.simulateMessage(inbound);

      expect(view.messages[0]?.clientId).toBe('conn-bob');
    });

    it('skips inbound messages missing x-ably-msg-id', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();

      const inbound = makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice' });
      // CAST: drop the message id header to exercise the rejection path.
      (inbound.extras as { headers: Record<string, string> }).headers = {
        [Headers.Role]: 'user',
        [Headers.ClientId]: 'alice',
      };
      channel.simulateMessage(inbound);

      expect(view.messages).toHaveLength(0);
    });

    it('skips inbound messages with an invalid x-ably-role', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();

      channel.simulateMessage(
        // CAST: deliberately invalid role to exercise rejection.
        makeInbound({ serial: '01', msgId: 'm-1', role: 'bot' as 'user', clientId: 'alice' }),
      );

      expect(view.messages).toHaveLength(0);
    });

    it('skips inbound messages with no clientId in headers or message', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();

      // No header clientId, no connection-level clientId — should be rejected.
      channel.simulateMessage(makeInbound({ serial: '01', msgId: 'm-1', role: 'user' }));

      expect(view.messages).toHaveLength(0);
    });

    it('skips inbound messages missing x-ably-run-id', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();

      const inbound = makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice' });
      // CAST: drop the run-id header to exercise the rejection path.
      (inbound.extras as { headers: Record<string, string> }).headers = {
        [Headers.MessageId]: 'm-1',
        [Headers.Role]: 'user',
        [Headers.ClientId]: 'alice',
      };
      channel.simulateMessage(inbound);

      expect(view.messages).toHaveLength(0);
    });

    it('orders nodes by serial when messages arrive out of order', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();

      channel.simulateMessage(
        makeInbound({ serial: '02', msgId: 'b', role: 'user', clientId: 'alice', data: 'second' }),
      );
      channel.simulateMessage(
        makeInbound({ serial: '01', msgId: 'a', role: 'user', clientId: 'alice', data: 'first' }),
      );

      expect(view.messages.map((n) => n.id)).toEqual(['a', 'b']);
    });

    it('updates the existing node when a subsequent inbound arrives under the same message id', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();
      const handler = vi.fn();
      view.subscribe(handler);

      channel.simulateMessage(
        makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice', data: 'hello' }),
      );
      channel.simulateMessage(
        makeInbound({ serial: '02', msgId: 'm-1', role: 'user', clientId: 'alice', data: 'world' }),
      );

      // Streaming codecs publish multiple chunks under one msg-id; the second
      // chunk must reach the accumulator and update the composed message
      // rather than being silently dropped.
      expect(view.messages).toHaveLength(1);
      expect(view.messages[0]?.id).toBe('m-1');
      expect(view.messages[0]?.serial).toBe('01');
      expect(view.messages[0]?.message).toBe('world');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not fire view subscribers after the view is closed', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();
      const handler = vi.fn();
      view.subscribe(handler);

      view.close();
      channel.simulateMessage(makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('logs and skips when the decoder throws — subsequent messages still flow', async () => {
      const channel = createMockChannel();
      const realtime = createMockRealtime(channel);
      const logger = makeLogger({ logLevel: LogLevel.Silent });
      let throwOnce = true;
      const throwingCodec: StubCodec = {
        ...stubCodec,
        createDecoder: () => ({
          decode: (message) => {
            if (throwOnce) {
              throwOnce = false;
              throw new Error('decoder boom');
            }
            return stubCodec.createDecoder().decode(message);
          },
        }),
      };
      const session = createClientSession({
        client: realtime,
        sessionName: 'session-1',
        codec: throwingCodec,
        logger,
      });
      await session.connect();
      const view = session.createView();

      // First inbound trips the decoder — should not throw, view stays empty.
      channel.simulateMessage(makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice' }));
      expect(view.messages).toHaveLength(0);

      // Subsequent inbound succeeds.
      channel.simulateMessage(makeInbound({ serial: '02', msgId: 'm-2', role: 'user', clientId: 'alice' }));
      expect(view.messages.map((n) => n.id)).toEqual(['m-2']);
    });

    it('unsubscribes from the channel on session.close()', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session.close();

      expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('continues to apply messages to the tree even when no view is registered', async () => {
      // A session created via createAgentSession has no createView surface,
      // but the decode loop still feeds the tree so that phase 7's createRun
      // can read the same state once it lands.
      const { options, channel } = makeSession();
      const session = createAgentSession(options);
      await session.connect();

      // No throw — the inbound is processed silently.
      expect(() => {
        channel.simulateMessage(makeInbound({ serial: '01', msgId: 'm-1', role: 'user', clientId: 'alice' }));
      }).not.toThrow();
    });
  });

  describe('run lifecycle decode', () => {
    it('records an active run on x-ably-run-start', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: { [Headers.RunId]: 'r-1' },
          clientId: 'alice',
        }),
      );

      const tree = treeOf(session);
      expect(tree.runs).toEqual<Run<string>[]>([{ id: 'r-1', status: 'active', initiatorClientId: 'alice' }]);
    });

    it('honours x-ably-client-id over the connection clientId on run-start', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: {
            [Headers.RunId]: 'r-1',
            [Headers.ClientId]: 'end-user-1',
          },
          clientId: 'conn-bob',
        }),
      );

      expect(treeOf(session).runs[0]?.initiatorClientId).toBe('end-user-1');
    });

    it('skips run-start without x-ably-run-id', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: {},
          clientId: 'alice',
        }),
      );

      expect(treeOf(session).runs).toHaveLength(0);
    });

    it('skips run-start with no clientId in headers or message', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: { [Headers.RunId]: 'r-1' },
        }),
      );

      expect(treeOf(session).runs).toHaveLength(0);
    });

    it('transitions a run to complete on x-ably-run-end', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: { [Headers.RunId]: 'r-1' },
          clientId: 'alice',
        }),
      );
      channel.simulateMessage(
        makeRunInbound({
          serial: '02',
          name: WireMessages.RunEnd,
          headers: { [Headers.RunId]: 'r-1', [Headers.Status]: 'complete' },
          clientId: 'alice',
        }),
      );

      expect(treeOf(session).runs[0]?.status).toBe('complete');
    });

    it('skips run-end with an invalid x-ably-status', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: { [Headers.RunId]: 'r-1' },
          clientId: 'alice',
        }),
      );
      channel.simulateMessage(
        makeRunInbound({
          serial: '02',
          name: WireMessages.RunEnd,
          headers: { [Headers.RunId]: 'r-1', [Headers.Status]: 'totally-bogus' },
          clientId: 'alice',
        }),
      );

      expect(treeOf(session).runs[0]?.status).toBe('active');
    });

    it('skips run-end without x-ably-run-id', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: { [Headers.RunId]: 'r-1' },
          clientId: 'alice',
        }),
      );
      channel.simulateMessage(
        makeRunInbound({
          serial: '02',
          name: WireMessages.RunEnd,
          headers: { [Headers.Status]: 'complete' },
          clientId: 'alice',
        }),
      );

      expect(treeOf(session).runs[0]?.status).toBe('active');
    });

    it('drives view subscribers from run state changes via the tree', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const view = session.createView();
      const handler = vi.fn();
      view.subscribe(handler);

      channel.simulateMessage(
        makeRunInbound({
          serial: '01',
          name: WireMessages.RunStart,
          headers: { [Headers.RunId]: 'r-1' },
          clientId: 'alice',
        }),
      );
      channel.simulateMessage(
        makeRunInbound({
          serial: '02',
          name: WireMessages.RunEnd,
          headers: { [Headers.RunId]: 'r-1', [Headers.Status]: 'complete' },
          clientId: 'alice',
        }),
      );

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
