import * as Ably from 'ably';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_IDS,
  HEADER_INVOCATION_ID,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEP_CLIENT_ID,
  HEADER_STEP_ID,
  HEADER_STEP_REASON,
  HEADER_STEP_START_SERIAL,
} from '../../../src/constants.js';
import type { RunManager } from '../../../src/core/transport/run-manager.js';
import { createRunManager } from '../../../src/core/transport/run-manager.js';
import { getTransportHeaders } from '../../../src/utils.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';

/**
 * Read the transport-tier headers off a recorded publish. The run manager
 * writes only transport-tier headers, so this sees everything it stamps.
 * @param msg - The recorded publish (undefined tolerated so call sites can
 * index `publishCalls` directly after asserting its length).
 * @returns The transport headers record.
 */
const headersOf = (msg: Ably.Message | undefined): Record<string, string> =>
  // CAST: the mock records outbound Ably.Message publishes; getTransportHeaders
  // reads only `extras`, which both message shapes carry.
  getTransportHeaders(msg as Ably.InboundMessage);

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

      const headers = headersOf(msg);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
    });

    it('defaults clientId to empty string when omitted', async () => {
      await manager.startRun('run-1');

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });

    it('publishes ai-run-resume (not ai-run-start) when continuation metadata is set', async () => {
      await manager.startRun('run-1', 'user-a', {
        continuation: true,
        invocationId: 'inv-2',
        inputClientId: 'user-b',
        inputTransportMessageId: 'trigger-msg',
      });

      const msg = channel.publishCalls.at(0);
      expect(msg?.name).toBe(EVENT_RUN_RESUME);
      const headers = headersOf(msg);
      // A resume carries the per-invocation correlation/attribution...
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-2');
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
      expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('publishes ai-run-start when continuation is false or unset', async () => {
      await manager.startRun('run-1', 'user-a', { continuation: false });
      await manager.startRun('run-2', 'user-a');

      expect(channel.publishNames()).toEqual([EVENT_RUN_START, EVENT_RUN_START]);
    });

    it('stamps input-client-id when inputClientId is set', async () => {
      await manager.startRun('run-1', 'user-a', { inputClientId: 'user-b' });

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    });

    it('omits input-client-id when inputClientId is unset', async () => {
      await manager.startRun('run-1', 'user-a');

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    });

    it('stamps input-transport-message-id when metadata.inputTransportMessageId is set', async () => {
      await manager.startRun('run-1', 'user-a', { inputTransportMessageId: 'trigger-msg' });

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('omits input-transport-message-id when inputTransportMessageId is unset', async () => {
      await manager.startRun('run-1', 'user-a');

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_ID);
    });
  });

  describe('endRun', () => {
    it('publishes run-end event with reason', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      expect(channel.publishCalls).toHaveLength(2);
      const msg = channel.publishCalls.at(1);
      expect(msg?.name).toBe(EVENT_RUN_END);

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
        { invocationId: 'inv-1', inputClientId: 'user-a', inputTransportMessageId: 'trigger' },
        new Ably.ErrorInfo('invalid x-api-key', 104008, 500),
      );

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_RUN_REASON]).toBe('error');
      expect(headers[HEADER_ERROR_CODE]).toBe('104008');
      expect(headers[HEADER_ERROR_MESSAGE]).toBe('invalid x-api-key');
    });

    it('omits error headers on a run-end with reason error but no error supplied', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'error');

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_RUN_REASON]).toBe('error');
      expect(headers).not.toHaveProperty(HEADER_ERROR_CODE);
      expect(headers).not.toHaveProperty(HEADER_ERROR_MESSAGE);
    });

    it('does not stamp error headers when an error is passed with a non-error reason', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', undefined, new Ably.ErrorInfo('x', 104008, 500));

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers).not.toHaveProperty(HEADER_ERROR_CODE);
      expect(headers).not.toHaveProperty(HEADER_ERROR_MESSAGE);
    });

    it('removes run from active set after publish', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      // The run is gone from the active set, so its owner is no longer known.
      expect(manager.getClientId('run-1')).toBeUndefined();
    });

    it('defaults clientId to empty string for unknown run', async () => {
      await manager.endRun('unknown', 'error');

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });

    it('stamps input-client-id when inputClientId is provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', { invocationId: 'inv-1', inputClientId: 'user-b' });

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    });

    it('omits input-client-id when inputClientId is unset', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    });

    it('stamps input-transport-message-id when inputTransportMessageId is provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', {
        invocationId: 'inv-1',
        inputClientId: 'user-b',
        inputTransportMessageId: 'trigger-msg',
      });

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('omits input-transport-message-id when inputTransportMessageId is unset', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_ID);
    });

    it('stamps the input receipt when consideredInputIds is provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete', { consideredInputIds: ['in-1', 'steer-1'] });

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_IDS]).toBe(JSON.stringify(['in-1', 'steer-1']));
    });

    it('omits the input receipt when consideredInputIds is unset', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_IDS);
    });
  });

  describe('suspendRun', () => {
    it('publishes a run-suspend event with run-id, run-client-id, and invocation-id', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', { invocationId: 'inv-1' });

      expect(channel.publishCalls).toHaveLength(2);
      const msg = channel.publishCalls.at(1);
      expect(msg?.name).toBe(EVENT_RUN_SUSPEND);

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

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers).not.toHaveProperty(HEADER_INVOCATION_ID);
    });

    it('stamps input attribution, mirroring run-end', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', {
        invocationId: 'inv-1',
        inputClientId: 'user-b',
        inputTransportMessageId: 'trigger-msg',
      });

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
      expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID]).toBe('trigger-msg');
    });

    it('stamps the input receipt when consideredInputIds is provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', { invocationId: 'inv-1', consideredInputIds: ['in-1', 'steer-1'] });

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_IDS]).toBe(JSON.stringify(['in-1', 'steer-1']));
    });

    it('omits input attribution when not provided', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', { invocationId: 'inv-1' });

      const headers = headersOf(channel.publishCalls.at(1));
      expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
      expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_ID);
      expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_IDS);
    });

    it('drops the run from the active set', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.suspendRun('run-1', { invocationId: 'inv-1' });

      // The agent process terminates on suspend; the run is dropped, so its
      // owner is no longer known.
      expect(manager.getClientId('run-1')).toBeUndefined();
    });

    it('defaults run-client-id to empty string for an unknown run', async () => {
      await manager.suspendRun('unknown');

      const headers = headersOf(channel.publishCalls.at(0));
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

  describe('startStep', () => {
    it('publishes ai-step-start with run-id and step-id (no step-start-serial back-ref) and returns its serial', async () => {
      const stepStartSerial = await manager.startStep('run-1', 'step-0');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg?.name).toBe(EVENT_STEP_START);
      const headers = headersOf(msg);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_STEP_ID]).toBe('step-0');
      // A step-start carries no back-ref — its own serial is the identity.
      expect(headers[HEADER_STEP_START_SERIAL]).toBeUndefined();
      expect(headers[HEADER_STEP_REASON]).toBeUndefined();
      // The publish ACK serial is returned as the attempt's step-start-serial.
      expect(stepStartSerial).toBe('serial-1');
    });

    it('returns undefined when the publish yields no serial', async () => {
      // A publish that returns no serial (empty serials array) — startStep then
      // has no `step-start-serial` to return.
      const noSerialResult: Ably.PublishResult = { serials: [] };
      channel.publish.mockResolvedValueOnce(noSerialResult);
      const stepStartSerial = await manager.startStep('run-1', 'step-0');
      expect(stepStartSerial).toBeUndefined();
    });

    it('forwards the invocation correlation and the three client-identity scopes onto the wire', async () => {
      await manager.startStep('run-1', 'step-0', {
        invocationId: 'inv-1',
        runClientId: 'owner',
        invocationClientId: 'invoker',
        stepClientId: 'stepper',
      });

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('owner');
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('invoker');
      expect(headers[HEADER_STEP_CLIENT_ID]).toBe('stepper');
    });
  });

  describe('endStep', () => {
    it('publishes ai-step-end stamping the step-start-serial back-ref and the step-reason', async () => {
      await manager.endStep('run-1', 'step-0', 'serial-1', 'failed');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg?.name).toBe(EVENT_STEP_END);
      const headers = headersOf(msg);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_STEP_ID]).toBe('step-0');
      expect(headers[HEADER_STEP_START_SERIAL]).toBe('serial-1');
      expect(headers[HEADER_STEP_REASON]).toBe('failed');
    });

    it('forwards the client-identity scopes alongside the step-reason', async () => {
      await manager.endStep('run-1', 'step-0', 'serial-1', 'complete', {
        invocationId: 'inv-1',
        runClientId: 'owner',
        invocationClientId: 'invoker',
        stepClientId: 'stepper',
      });

      const headers = headersOf(channel.publishCalls.at(0));
      expect(headers[HEADER_STEP_REASON]).toBe('complete');
      expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('owner');
      expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('invoker');
      expect(headers[HEADER_STEP_CLIENT_ID]).toBe('stepper');
    });
  });
});
