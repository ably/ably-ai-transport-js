import '../../helper/expectations.js';

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_SUSPEND,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEER_TRANSPORT_MESSAGE_IDS,
  HEADER_TRANSPORT_MESSAGE_ID,
} from '../../../src/constants.js';
import type { WriteOptions } from '../../../src/core/codec/types.js';
import { SteerCoordinator } from '../../../src/core/transport/steer-coordinator.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

interface TestInput {
  kind: 'user-message';
  text: string;
}

interface PublishCall {
  input: TestInput;
  opts: WriteOptions;
}

interface Harness {
  coord: SteerCoordinator<TestInput>;
  publishCalls: PublishCall[];
  publishImpl: { fn: (input: TestInput, opts: WriteOptions) => Promise<Ably.PublishResult> };
  closed: { value: boolean };
}

const makeHarness = (clientId: string | undefined = 'client-a'): Harness => {
  const publishCalls: PublishCall[] = [];
  const closed = { value: false };
  // Wrapped so individual tests can override the publish behaviour
  // (e.g. to make it reject) without re-constructing the coordinator.
  const publishImpl = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock builds the resolved promise directly
    fn: (input: TestInput, opts: WriteOptions): Promise<Ably.PublishResult> => {
      publishCalls.push({ input, opts });
      return Promise.resolve({ serials: [`ack-serial-${String(publishCalls.length)}`] });
    },
  };
  const coord = new SteerCoordinator<TestInput>({
    publish: async (input, opts) => publishImpl.fn(input, opts),
    clientId: () => clientId,
    isTransportClosed: () => closed.value,
    logger: makeLogger({ logLevel: LogLevel.Silent }),
  });
  return { coord, publishCalls, publishImpl, closed };
};

// Build an Ably.InboundMessage stub with the given headers / name / serial.
const ablyMsg = (
  name: string,
  headers: Record<string, string>,
  serial = `serial-${String(Math.random()).slice(2, 8)}`,
): Ably.InboundMessage =>
  ({
    name,
    serial,
    extras: { ai: { transport: headers } },
    version: { serial },
  }) as unknown as Ably.InboundMessage;

// Pull the steer publish's minted transport-message-id off the latest publish call.
const lastSteerTransportMessageId = (h: Harness): string => {
  const last = h.publishCalls.at(-1);
  if (!last) throw new Error('no publish observed');
  const id = last.opts.extras?.headers?.[HEADER_TRANSPORT_MESSAGE_ID];
  if (!id) throw new Error('publish has no transport-message-id');
  return id;
};

// Settle the microtask queue so the coordinator's async IIFE makes progress.
const flush = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

describe('SteerCoordinator', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------
  // steer() — publish lifecycle
  // ---------------------------------------------------------------------

  describe('steer()', () => {
    it('publishes to the channel once the runIdPromise resolves', async () => {
      const { coord, publishCalls } = h;
      const { published } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      expect(publishCalls).toHaveLength(1);
      // `published` resolves from the publish acknowledgement's serial.
      await expect(published).resolves.toEqual({ serial: 'ack-serial-1' });
    });

    it('stamps the resolved runId, the publisher clientId, and a minted transport-message-id', async () => {
      const { coord, publishCalls } = h;
      coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      const headers = publishCalls.at(0)?.opts.extras?.headers ?? {};
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers.role).toBe('user');
      expect(headers['run-client-id']).toBe('client-a');
      expect(headers[HEADER_TRANSPORT_MESSAGE_ID]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects both promises when the runIdPromise rejects', async () => {
      const { coord } = h;
      const runIdErr = new Ably.ErrorInfo('runId never resolved', ErrorCode.InvalidArgument, 400);
      const { published, outcome } = coord.steer(Promise.reject(runIdErr), { kind: 'user-message', text: 'hi' });
      await expect(published).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('rejects synchronously when the run is already in the dead set', async () => {
      const { coord } = h;
      // Drive the coordinator into the dead state for run-1 via a run-end.
      coord.observeMessage(
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );
      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'late' });
      await expect(published).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(h.publishCalls).toHaveLength(0);
    });

    it('rejects with SessionClosed when isTransportClosed() returns true', async () => {
      const { coord, closed } = h;
      closed.value = true;
      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await expect(published).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
      expect(h.publishCalls).toHaveLength(0);
    });

    it('rejects with InsufficientCapability on a 403 publish error', async () => {
      const { coord, publishImpl } = h;
      const cause = new Ably.ErrorInfo('forbidden', 40300, 403);
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock that returns a pre-built rejection
      publishImpl.fn = () => Promise.reject(cause);
      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await expect(published).rejects.toBeErrorInfoWithCode(ErrorCode.InsufficientCapability);
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.InsufficientCapability);
    });

    it('rejects with SessionSendFailed on a generic publish error', async () => {
      const { coord, publishImpl } = h;
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock that returns a pre-built rejection
      publishImpl.fn = () => Promise.reject(new Error('network'));
      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await expect(published).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSendFailed);
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSendFailed);
    });
  });

  // ---------------------------------------------------------------------
  // observeMessage() — echo match, stamp accumulation, lifecycle
  // ---------------------------------------------------------------------

  describe('observeMessage()', () => {
    it('resolves published with the publish acknowledgement serial — no echo involved', async () => {
      const { coord } = h;
      const { published } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await expect(published).resolves.toEqual({ serial: 'ack-serial-1' });
    });

    it('resolves outcome consumed: true when the steer id is stamped before run-end', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      const id = lastSteerTransportMessageId(h);
      // Agent stamps the id on a response message.
      coord.observeMessage(
        ablyMsg('ai-output', {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: JSON.stringify([id]),
        }),
      );
      coord.observeMessage(ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' }));
      await expect(outcome).resolves.toEqual({ consumed: true, runTerminalReason: 'complete' });
    });

    it('resolves outcome consumed: false on run-end when the id was never stamped', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      coord.observeMessage(
        ablyMsg('ai-output', {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: JSON.stringify(['some-other-id']),
        }),
      );
      coord.observeMessage(ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' }));
      await expect(outcome).resolves.toEqual({ consumed: false, runTerminalReason: 'complete' });
    });

    it('on run-suspend leaves outcome pending when the id has not been stamped', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      coord.observeMessage(ablyMsg(EVENT_RUN_SUSPEND, { [HEADER_RUN_ID]: 'run-1' }));
      const sentinel = Symbol('pending');
      const result = await Promise.race([outcome, Promise.resolve(sentinel)]);
      expect(result).toBe(sentinel);
    });

    it('unions stamps across multiple response messages for the run', async () => {
      const { coord } = h;
      const s1 = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'a' });
      await flush();
      const idA = lastSteerTransportMessageId(h);
      const s2 = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'b' });
      await flush();
      const idB = lastSteerTransportMessageId(h);
      // Two response deltas, each stamping one id.
      coord.observeMessage(
        ablyMsg('ai-output', { [HEADER_RUN_ID]: 'run-1', [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: JSON.stringify([idA]) }),
      );
      coord.observeMessage(
        ablyMsg('ai-output', { [HEADER_RUN_ID]: 'run-1', [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: JSON.stringify([idB]) }),
      );
      coord.observeMessage(ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' }));
      await expect(s1.outcome).resolves.toEqual({ consumed: true, runTerminalReason: 'complete' });
      await expect(s2.outcome).resolves.toEqual({ consumed: true, runTerminalReason: 'complete' });
    });

    it('ignores malformed JSON in steer-transport-message-ids', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      coord.observeMessage(
        ablyMsg('ai-output', { [HEADER_RUN_ID]: 'run-1', [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: 'not-json' }),
      );
      coord.observeMessage(ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' }));
      await expect(outcome).resolves.toEqual({ consumed: false, runTerminalReason: 'complete' });
    });

    it('ignores a non-array JSON payload in steer-transport-message-ids', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      const id = lastSteerTransportMessageId(h);
      coord.observeMessage(
        ablyMsg('ai-output', {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_STEER_TRANSPORT_MESSAGE_IDS]: JSON.stringify({ id }),
        }),
      );
      coord.observeMessage(ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' }));
      await expect(outcome).resolves.toEqual({ consumed: false, runTerminalReason: 'complete' });
    });

    it('resolves a steer not-consumed when the run ends while its publish is in flight', async () => {
      const { coord, publishImpl } = h;
      const { promise: ackGate, resolve: releaseAck } = Promise.withResolvers<Ably.PublishResult>();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- return the gate promise by reference
      publishImpl.fn = () => ackGate;

      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      // The terminal lands before the publish acknowledges.
      coord.observeMessage(ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' }));
      releaseAck({ serials: ['ack-late'] });

      await expect(published).resolves.toEqual({ serial: 'ack-late' });
      await expect(outcome).resolves.toEqual({ consumed: false, runTerminalReason: 'complete' });
    });
  });

  // ---------------------------------------------------------------------
  // drainContinuityLost() / drainClosed()
  // ---------------------------------------------------------------------

  describe('drainContinuityLost()', () => {
    it('rejects in-flight outcomes with the supplied error', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      const err = new Ably.ErrorInfo('continuity lost', ErrorCode.SessionContinuityNotGuaranteed, 500);
      coord.drainContinuityLost(err);
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.SessionContinuityNotGuaranteed);
    });

    it('rejects the outcome of a steer whose publish was in flight at the drain', async () => {
      const { coord, publishImpl } = h;
      const { promise: ackGate, resolve: releaseAck } = Promise.withResolvers<Ably.PublishResult>();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- return the gate promise by reference
      publishImpl.fn = () => ackGate;

      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      coord.drainContinuityLost(new Ably.ErrorInfo('continuity lost', ErrorCode.SessionContinuityNotGuaranteed, 500));
      releaseAck({ serials: ['ack-late'] });

      // The publish itself was acknowledged, so published still resolves; the
      // outcome can never be observed post-drain, so it rejects.
      await expect(published).resolves.toEqual({ serial: 'ack-late' });
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.SessionContinuityNotGuaranteed);
    });
  });

  describe('drainClosed()', () => {
    it('rejects in-flight outcomes with SessionClosed', async () => {
      const { coord } = h;
      const { outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      coord.drainClosed();
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });

    it('rejects the outcome of a steer whose publish was in flight at the close', async () => {
      const { coord, publishImpl } = h;
      const { promise: ackGate, resolve: releaseAck } = Promise.withResolvers<Ably.PublishResult>();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- return the gate promise by reference
      publishImpl.fn = () => ackGate;

      const { published, outcome } = coord.steer(Promise.resolve('run-1'), { kind: 'user-message', text: 'hi' });
      await flush();
      coord.drainClosed();
      releaseAck({ serials: ['ack-late'] });

      await expect(published).resolves.toEqual({ serial: 'ack-late' });
      await expect(outcome).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });
  });
});
