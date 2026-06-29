import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_ATTEMPT_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEP_CLIENT_ID,
  HEADER_STEP_ID,
  HEADER_STEP_REASON,
} from '../../../src/constants.js';
import type { RunManager } from '../../../src/core/transport/run-manager.js';
import { createRunManager } from '../../../src/core/transport/run-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  publishCalls: Ably.Message[];
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    publishCalls: [],
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns resolved promise
    publish: vi.fn(async (msg: Ably.Message) => {
      mock.publishCalls.push(msg);
    }),
  };
  // CAST: Tests only use publish — other RealtimeChannel members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

const headersOf = (msg: Ably.Message): Record<string, string> => {
  const ai = (msg.extras as { ai?: { transport?: Record<string, string>; codec?: Record<string, string> } }).ai;
  return { ...ai?.transport, ...ai?.codec };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunManager', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let manager: RunManager;

  beforeEach(() => {
    channel = createMockChannel();
    manager = createRunManager(channel);
  });

  describe('startRun', () => {
    it('publishes run-start event with correct headers', async () => {
      await manager.startRun('run-1', 'user-a');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg).toBeDefined();
      expect(msg?.name).toBe(EVENT_RUN_START);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect above
      const headers = headersOf(msg!);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
    });

    it('adopts the external controller so close() aborts it', async () => {
      const controller = new AbortController();
      await manager.startRun('run-1', 'user-a', controller);
      expect(controller.signal.aborted).toBe(false);

      manager.close();
      expect(controller.signal.aborted).toBe(true);
    });

    it('defaults clientId to empty string when omitted', async () => {
      await manager.startRun('run-1');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });

    it('publishes ai-run-resume (not ai-run-start) when continuation metadata is set', async () => {
      await manager.startRun('run-1', 'user-a', undefined, {
        continuation: true,
        invocationId: 'inv-2',
        inputClientId: 'user-b',
        inputCodecMessageId: 'trigger-msg',
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const msg = channel.publishCalls.at(0)!;
      expect(msg.name).toBe(EVENT_RUN_RESUME);
      const headers = headersOf(msg);
      // A resume carries the per-invocation correlation/attribution...
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-2');
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
      expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('omits structural metadata (parent/forkOf/regenerates) on a resume', async () => {
      await manager.startRun('run-1', 'user-a', undefined, {
        continuation: true,
        parent: 'p',
        forkOf: 'f',
        regenerates: 'r',
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      // ...but not structure — the original run-start owns that.
      expect(headers).not.toHaveProperty(HEADER_PARENT);
      expect(headers).not.toHaveProperty(HEADER_FORK_OF);
      expect(headers).not.toHaveProperty(HEADER_MSG_REGENERATE);
    });

    it('publishes ai-run-start when continuation is false or unset', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { continuation: false });
      await manager.startRun('run-2', 'user-a');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      expect(channel.publishCalls.at(0)!.name).toBe(EVENT_RUN_START);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      expect(channel.publishCalls.at(1)!.name).toBe(EVENT_RUN_START);
    });

    it('stamps input-client-id when inputClientId is set', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { inputClientId: 'user-b' });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    });

    it('omits input-client-id when inputClientId is unset', async () => {
      await manager.startRun('run-1', 'user-a');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    });

    it('stamps fork-of when metadata.forkOf is set (edit run-start)', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { forkOf: 'orig-user-msg' });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_FORK_OF]).toBe('orig-user-msg');
      expect(headers[HEADER_MSG_REGENERATE]).toBeUndefined();
    });

    it('stamps msg-regenerate when metadata.regenerates is set (regenerate run-start)', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { regenerates: 'orig-asst-msg' });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_MSG_REGENERATE]).toBe('orig-asst-msg');
      expect(headers[HEADER_FORK_OF]).toBeUndefined();
    });

    it('stamps input-codec-message-id when metadata.inputCodecMessageId is set', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { inputCodecMessageId: 'trigger-msg' });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('omits input-codec-message-id when inputCodecMessageId is unset', async () => {
      await manager.startRun('run-1', 'user-a');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers).not.toHaveProperty(HEADER_INPUT_CODEC_MESSAGE_ID);
    });
  });

  describe('registerRun', () => {
    it('seeds the run owner WITHOUT publishing any lifecycle event', () => {
      manager.registerRun('run-1', 'user-a');

      // The owner is queryable for output / terminal stamping...
      expect(manager.getClientId('run-1')).toBe('user-a');
      // ...but registering alone publishes nothing on the channel.
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('defaults clientId to empty string when omitted', () => {
      manager.registerRun('run-1');
      expect(manager.getClientId('run-1')).toBe('');
    });

    it('adopts the external controller so close() aborts it', () => {
      const controller = new AbortController();
      manager.registerRun('run-1', 'user-a', controller);
      expect(controller.signal.aborted).toBe(false);

      manager.close();
      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe('endRun', () => {
    it('publishes run-end event with reason', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      expect(channel.publishCalls).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const msg = channel.publishCalls.at(1)!;
      expect(msg.name).toBe(EVENT_RUN_END);

      const headers = headersOf(msg);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
      expect(headers[HEADER_RUN_REASON]).toBe('complete');
    });

    it('stamps error-code and error-message on a run-end with reason error and an error', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun(
        'run-1',
        'error',
        'inv-1',
        'user-a',
        'trigger',
        new Ably.ErrorInfo('invalid x-api-key', 104008, 500),
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted by prior calls
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers[HEADER_RUN_REASON]).toBe('error');
      expect(headers[HEADER_ERROR_CODE]).toBe('104008');
      expect(headers[HEADER_ERROR_MESSAGE]).toBe('invalid x-api-key');
    });

    it('omits error headers on a run-end with reason error but no error supplied', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'error');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted by prior calls
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers[HEADER_RUN_REASON]).toBe('error');
      expect(headers).not.toHaveProperty(HEADER_ERROR_CODE);
      expect(headers).not.toHaveProperty(HEADER_ERROR_MESSAGE);
    });

    it('does not stamp error headers when an error is passed with a non-error reason', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', undefined, undefined, undefined, new Ably.ErrorInfo('x', 104008, 500));

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted by prior calls
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers).not.toHaveProperty(HEADER_ERROR_CODE);
      expect(headers).not.toHaveProperty(HEADER_ERROR_MESSAGE);
    });

    it('removes run from active set after publish', async () => {
      const controller = new AbortController();
      await manager.startRun('run-1', undefined, controller);
      await manager.endRun('run-1', 'complete');

      // The run is gone from the active set, so a later close() does not abort it.
      manager.close();
      expect(controller.signal.aborted).toBe(false);
    });

    it('defaults clientId to empty string for unknown run', async () => {
      await manager.endRun('unknown', 'error');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });

    it('stamps input-client-id when inputClientId is provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', 'inv-1', 'user-b');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    });

    it('omits input-client-id when inputClientId is unset', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    });

    it('stamps input-codec-message-id when inputCodecMessageId is provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', 'inv-1', 'user-b', 'trigger-msg');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('omits input-codec-message-id when inputCodecMessageId is unset', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers).not.toHaveProperty(HEADER_INPUT_CODEC_MESSAGE_ID);
    });
  });

  describe('suspendRun', () => {
    it('publishes a run-suspend event with run-id, run-client-id, and invocation-id', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', 'inv-1');

      expect(channel.publishCalls).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const msg = channel.publishCalls.at(1)!;
      expect(msg.name).toBe(EVENT_RUN_SUSPEND);

      const headers = headersOf(msg);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
      // A suspend carries no run-reason — it is not a terminal event.
      expect(headers).not.toHaveProperty(HEADER_RUN_REASON);
    });

    it('omits invocation-id when not provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers).not.toHaveProperty(HEADER_INVOCATION_ID);
    });

    it('stamps input attribution, mirroring run-end', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', 'inv-1', 'user-b', 'trigger-msg');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
      expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('omits input attribution when not provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', 'inv-1');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(1)!);
      expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
      expect(headers).not.toHaveProperty(HEADER_INPUT_CODEC_MESSAGE_ID);
    });

    it('drops the run from the active set so a later close() is a no-op for it', async () => {
      const controller = new AbortController();
      await manager.startRun('run-1', 'user-a', controller);
      await manager.suspendRun('run-1', 'inv-1');

      // The agent process terminates on suspend; the run is dropped, so close()
      // has no controller to abort for it.
      manager.close();
      expect(controller.signal.aborted).toBe(false);
    });

    it('defaults run-client-id to empty string for an unknown run', async () => {
      await manager.suspendRun('unknown');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });
  });

  describe('getClientId', () => {
    it('returns clientId for active run', async () => {
      await manager.startRun('run-1', 'user-a');
      expect(manager.getClientId('run-1')).toBe('user-a');
    });

    it('returns undefined for unknown run', () => {
      expect(manager.getClientId('nope')).toBeUndefined();
    });
  });

  describe('close', () => {
    it('aborts all active runs', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      await manager.startRun('run-1', 'user-a', controller1);
      await manager.startRun('run-2', 'user-a', controller2);

      manager.close();

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(true);
    });
  });

  describe('startStep', () => {
    it('publishes ai-step-start with run-id, step-id, and attempt-id', async () => {
      await manager.startStep('run-1', 'step-0', 'att-1');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg?.name).toBe(EVENT_STEP_START);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect above
      const headers = headersOf(msg!);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_STEP_ID]).toBe('step-0');
      expect(headers[HEADER_ATTEMPT_ID]).toBe('att-1');
      expect(headers[HEADER_STEP_REASON]).toBeUndefined();
    });

    it('forwards the invocation correlation and the three client-identity scopes onto the wire', async () => {
      await manager.startStep('run-1', 'step-0', 'att-1', {
        invocationId: 'inv-1',
        runClientId: 'owner',
        invocationClientId: 'invoker',
        stepClientId: 'stepper',
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- single publish
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('owner');
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('invoker');
      expect(headers[HEADER_STEP_CLIENT_ID]).toBe('stepper');
    });
  });

  describe('endStep', () => {
    it('publishes ai-step-end stamping the step-reason', async () => {
      await manager.endStep('run-1', 'step-0', 'att-1', 'failed');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg?.name).toBe(EVENT_STEP_END);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect above
      const headers = headersOf(msg!);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_STEP_ID]).toBe('step-0');
      expect(headers[HEADER_ATTEMPT_ID]).toBe('att-1');
      expect(headers[HEADER_STEP_REASON]).toBe('failed');
    });

    it('forwards the client-identity scopes alongside the step-reason', async () => {
      await manager.endStep('run-1', 'step-0', 'att-1', 'complete', {
        invocationId: 'inv-1',
        runClientId: 'owner',
        invocationClientId: 'invoker',
        stepClientId: 'stepper',
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- single publish
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_STEP_REASON]).toBe('complete');
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('owner');
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('invoker');
      expect(headers[HEADER_STEP_CLIENT_ID]).toBe('stepper');
    });
  });
});
