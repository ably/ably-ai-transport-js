import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEP_CLIENT_ID,
  HEADER_STEP_ID,
  HEADER_STEP_REASON,
  HEADER_STEP_START_SERIAL,
} from '../../../src/constants.js';
import {
  buildLifecycleHeaders,
  buildRunEndError,
  buildStepHeaders,
  buildTransportHeaders,
  isStepLifecycleName,
  parseRunLifecycle,
  parseStepLifecycle,
} from '../../../src/core/transport/headers.js';
import { ErrorCode } from '../../../src/errors.js';

describe('buildTransportHeaders', () => {
  it('includes role, runId, and codecMessageId', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      codecMessageId: 'msg-1',
    });

    expect(headers[HEADER_ROLE]).toBe('user');
    expect(headers[HEADER_RUN_ID]).toBe('run-1');
    expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe('msg-1');
  });

  it('includes runClientId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      runClientId: 'user-a',
    });

    expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
  });

  it('includes parent when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      parent: 'parent-msg',
    });

    expect(headers[HEADER_PARENT]).toBe('parent-msg');
  });

  it('includes forkOf when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      forkOf: 'fork-msg',
    });

    expect(headers[HEADER_FORK_OF]).toBe('fork-msg');
  });

  it('includes inputClientId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      inputClientId: 'user-b',
    });

    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
  });

  it('includes inputClientId when set to empty string', () => {
    // Anonymous publishers (no Ably clientId on the connection) surface
    // as an empty string; the header still lands so receivers can
    // distinguish "absent" from "anonymous" downstream.
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      inputClientId: '',
    });

    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('');
  });

  it('includes inputCodecMessageId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      inputCodecMessageId: 'trigger-msg',
    });

    expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('trigger-msg');
  });

  it('includes regenerates as msg-regenerate when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      regenerates: 'asst-original',
    });

    expect(headers[HEADER_MSG_REGENERATE]).toBe('asst-original');
  });

  it('includes step-id, step-start-serial, and step-client-id when provided (step output)', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      codecMessageId: 'msg-1',
      stepId: 'step-0',
      stepStartSerial: 's-att-1',
      stepClientId: 'stepper',
    });

    expect(headers[HEADER_STEP_ID]).toBe('step-0');
    expect(headers[HEADER_STEP_START_SERIAL]).toBe('s-att-1');
    expect(headers[HEADER_STEP_CLIENT_ID]).toBe('stepper');
  });

  it('omits optional headers when undefined', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      codecMessageId: 'msg-1',
    });

    expect(headers).not.toHaveProperty(HEADER_RUN_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_PARENT);
    expect(headers).not.toHaveProperty(HEADER_FORK_OF);
    expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_INPUT_CODEC_MESSAGE_ID);
    expect(headers).not.toHaveProperty(HEADER_MSG_REGENERATE);
    expect(headers).not.toHaveProperty(HEADER_STEP_ID);
    expect(headers).not.toHaveProperty(HEADER_STEP_START_SERIAL);
    expect(headers).not.toHaveProperty(HEADER_STEP_CLIENT_ID);
  });
});

describe('buildLifecycleHeaders', () => {
  it('always stamps run-id and run-client-id', () => {
    const headers = buildLifecycleHeaders({ runId: 'run-1', runClientId: 'user-a' });
    expect(headers[HEADER_RUN_ID]).toBe('run-1');
    expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
  });

  it('stamps the run-reason only when provided (run-end)', () => {
    expect(buildLifecycleHeaders({ runId: 'r', runClientId: '', reason: 'error' })[HEADER_RUN_REASON]).toBe('error');
    expect(buildLifecycleHeaders({ runId: 'r', runClientId: '' })).not.toHaveProperty(HEADER_RUN_REASON);
  });

  it('stamps structural and correlation headers when provided', () => {
    const headers = buildLifecycleHeaders({
      runId: 'run-1',
      runClientId: 'user-a',
      parent: 'p',
      forkOf: 'f',
      regenerates: 'g',
      invocationId: 'inv-1',
      inputClientId: 'user-b',
      inputCodecMessageId: 'trigger',
    });
    expect(headers[HEADER_PARENT]).toBe('p');
    expect(headers[HEADER_FORK_OF]).toBe('f');
    expect(headers[HEADER_MSG_REGENERATE]).toBe('g');
    expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    expect(headers[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('trigger');
  });

  it('omits every optional header when not provided', () => {
    const headers = buildLifecycleHeaders({ runId: 'run-1', runClientId: 'user-a' });
    expect(headers).not.toHaveProperty(HEADER_RUN_REASON);
    expect(headers).not.toHaveProperty(HEADER_PARENT);
    expect(headers).not.toHaveProperty(HEADER_FORK_OF);
    expect(headers).not.toHaveProperty(HEADER_MSG_REGENERATE);
    expect(headers).not.toHaveProperty(HEADER_INVOCATION_ID);
    expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_INPUT_CODEC_MESSAGE_ID);
  });

  it('stamps empty-string correlation values (distinguished from omitted)', () => {
    const headers = buildLifecycleHeaders({ runId: 'run-1', runClientId: '', inputClientId: '' });
    expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('');
  });

  it('stamps error-code (as a string) and error-message when provided', () => {
    const headers = buildLifecycleHeaders({
      runId: 'r',
      runClientId: '',
      reason: 'error',
      errorCode: 104008,
      errorMessage: 'invalid x-api-key',
    });
    expect(headers[HEADER_ERROR_CODE]).toBe('104008');
    expect(headers[HEADER_ERROR_MESSAGE]).toBe('invalid x-api-key');
  });

  it('omits error-code and error-message when not provided', () => {
    const headers = buildLifecycleHeaders({ runId: 'r', runClientId: '', reason: 'error' });
    expect(headers).not.toHaveProperty(HEADER_ERROR_CODE);
    expect(headers).not.toHaveProperty(HEADER_ERROR_MESSAGE);
  });
});

describe('buildRunEndError', () => {
  it('reconstructs an ErrorInfo from the error-code / error-message headers', () => {
    const err = buildRunEndError({ [HEADER_ERROR_CODE]: '40003', [HEADER_ERROR_MESSAGE]: 'bad input' });
    expect(err).toBeInstanceOf(Ably.ErrorInfo);
    expect(err.code).toBe(40003);
    expect(err.message).toBe('bad input');
    expect(err.statusCode).toBe(400);
  });

  it('derives a 500 statusCode from a 5-digit server code', () => {
    const err = buildRunEndError({ [HEADER_ERROR_CODE]: '50000', [HEADER_ERROR_MESSAGE]: 'boom' });
    expect(err.statusCode).toBe(500);
  });

  it('falls back to StreamError and a generic message/status when the headers are absent', () => {
    const err = buildRunEndError({});
    expect(err.code).toBe(ErrorCode.StreamError);
    expect(err.message).toBe('agent reported an error');
    expect(err.statusCode).toBe(500);
  });

  it('falls back to StreamError and a 500 status for a non-numeric code', () => {
    const err = buildRunEndError({ [HEADER_ERROR_CODE]: 'not-a-number', [HEADER_ERROR_MESSAGE]: 'x' });
    expect(err.code).toBe(ErrorCode.StreamError);
    expect(err.statusCode).toBe(500);
  });
});

describe('parseRunLifecycle', () => {
  it('parses a minimal run-start', () => {
    const event = parseRunLifecycle(EVENT_RUN_START, { [HEADER_RUN_ID]: 'run-1' }, 's1', 1000);

    expect(event).toEqual({
      type: 'start',
      runId: 'run-1',
      clientId: '',
      serial: 's1',
      invocationId: '',
      timestamp: 1000,
    });
  });

  it('parses a fully-populated run-start', () => {
    const event = parseRunLifecycle(
      EVENT_RUN_START,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-1',
        [HEADER_PARENT]: 'parent-msg',
        [HEADER_FORK_OF]: 'fork-msg',
        [HEADER_MSG_REGENERATE]: 'asst-original',
      },
      's2',
      2000,
    );

    expect(event).toEqual({
      type: 'start',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's2',
      invocationId: 'inv-1',
      timestamp: 2000,
      parent: 'parent-msg',
      forkOf: 'fork-msg',
      regenerates: 'asst-original',
    });
  });

  it('omits optional run-start fields when their headers are absent', () => {
    const noTimestamp: number | undefined = undefined;
    const event = parseRunLifecycle(
      EVENT_RUN_START,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-1',
      },
      's1',
      noTimestamp,
    );

    expect(event).not.toHaveProperty('parent');
    expect(event).not.toHaveProperty('timestamp');
    expect(event).not.toHaveProperty('forkOf');
    expect(event).not.toHaveProperty('regenerates');
  });

  it('parses a run-end with an explicit reason', () => {
    const event = parseRunLifecycle(
      EVENT_RUN_END,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-1',
        [HEADER_RUN_REASON]: 'cancelled',
      },
      's5',
      5000,
    );

    expect(event).toEqual({
      type: 'end',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's5',
      invocationId: 'inv-1',
      reason: 'cancelled',
      timestamp: 5000,
    });
  });

  it('defaults the run-end reason to "complete" and invocationId to "" when absent, and stamps an undefined serial', () => {
    const noSerial: string | undefined = undefined;
    const noTimestamp: number | undefined = undefined;
    const event = parseRunLifecycle(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1' }, noSerial, noTimestamp);

    expect(event).toEqual({
      type: 'end',
      runId: 'run-1',
      clientId: '',
      serial: undefined,
      invocationId: '',
      reason: 'complete',
    });
  });

  it('parses a run-end error, reconstructing the terminal error from the error headers', () => {
    const noTimestamp: number | undefined = undefined;
    const event = parseRunLifecycle(
      EVENT_RUN_END,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-1',
        [HEADER_RUN_REASON]: 'error',
        [HEADER_ERROR_CODE]: '104008',
        [HEADER_ERROR_MESSAGE]: 'invalid x-api-key',
      },
      's5',
      noTimestamp,
    );

    if (event?.type !== 'end' || event.reason !== 'error') {
      expect.fail('expected an error end event');
    }
    expect(event.error).toBeInstanceOf(Ably.ErrorInfo);
    expect(event.error.code).toBe(104008);
    expect(event.error.message).toBe('invalid x-api-key');
  });

  it('omits the error field on a non-error run-end', () => {
    const noTimestamp: number | undefined = undefined;
    const event = parseRunLifecycle(
      EVENT_RUN_END,
      { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_REASON]: 'complete' },
      's6',
      noTimestamp,
    );

    if (event?.type !== 'end') {
      expect.fail('expected an end event');
    }
    expect(event.reason).toBe('complete');
    expect('error' in event).toBe(false);
  });

  it('parses a run-suspend into a suspend event carrying runId, clientId, serial, and invocationId', () => {
    const event = parseRunLifecycle(
      EVENT_RUN_SUSPEND,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-1',
      },
      's4',
      4000,
    );

    expect(event).toEqual({
      type: 'suspend',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's4',
      invocationId: 'inv-1',
      timestamp: 4000,
    });
  });

  it('defaults run-suspend clientId and invocationId to "" when absent and stamps an undefined serial', () => {
    const noSerial: string | undefined = undefined;
    const noTimestamp: number | undefined = undefined;
    const event = parseRunLifecycle(EVENT_RUN_SUSPEND, { [HEADER_RUN_ID]: 'run-1' }, noSerial, noTimestamp);

    expect(event).toEqual({
      type: 'suspend',
      runId: 'run-1',
      clientId: '',
      serial: undefined,
      invocationId: '',
    });
  });

  it('parses a run-resume into a resume event carrying runId, clientId, serial, and invocationId', () => {
    const event = parseRunLifecycle(
      EVENT_RUN_RESUME,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-2',
      },
      's6',
      6000,
    );

    expect(event).toEqual({
      type: 'resume',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's6',
      invocationId: 'inv-2',
      timestamp: 6000,
    });
  });

  it('returns undefined when run-id is missing', () => {
    expect(parseRunLifecycle(EVENT_RUN_START, {}, 's1', 1000)).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_SUSPEND, {}, 's1', 1000)).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_RESUME, {}, 's1', 1000)).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_END, {}, 's1', 1000)).toBeUndefined();
  });

  it('returns undefined for a non-lifecycle message name', () => {
    expect(parseRunLifecycle('ai-output', { [HEADER_RUN_ID]: 'run-1' }, 's1', 1000)).toBeUndefined();
  });
});

describe('buildStepHeaders', () => {
  it('stamps run-id and step-id, and omits step-start-serial on a step-start', () => {
    const headers = buildStepHeaders({ runId: 'run-1', stepId: 'step-0' });

    expect(headers[HEADER_RUN_ID]).toBe('run-1');
    expect(headers[HEADER_STEP_ID]).toBe('step-0');
    // A step-start carries no back-ref — its own serial is the identity.
    expect(headers).not.toHaveProperty(HEADER_STEP_START_SERIAL);
    expect(headers[HEADER_STEP_REASON]).toBeUndefined();
  });

  it('stamps step-start-serial and step-reason when provided (step-end)', () => {
    const headers = buildStepHeaders({
      runId: 'run-1',
      stepId: 'step-0',
      stepStartSerial: 's-att-1',
      reason: 'failed',
    });

    expect(headers[HEADER_STEP_START_SERIAL]).toBe('s-att-1');
    expect(headers[HEADER_STEP_REASON]).toBe('failed');
  });

  it('stamps the invocation correlation and the three client-identity scopes', () => {
    const headers = buildStepHeaders({
      runId: 'run-1',
      stepId: 'step-0',
      invocationId: 'inv-1',
      runClientId: 'owner',
      invocationClientId: 'invoker',
      stepClientId: 'stepper',
    });

    expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
    expect(headers[HEADER_RUN_CLIENT_ID]).toBe('owner');
    // invocationClientId rides the existing input-client-id wire name.
    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('invoker');
    expect(headers[HEADER_STEP_CLIENT_ID]).toBe('stepper');
  });

  it('omits the client scopes entirely when undefined, but stamps an empty-string value', () => {
    const omitted = buildStepHeaders({ runId: 'run-1', stepId: 'step-0' });
    expect(omitted).not.toHaveProperty(HEADER_INVOCATION_ID);
    expect(omitted).not.toHaveProperty(HEADER_RUN_CLIENT_ID);
    expect(omitted).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    expect(omitted).not.toHaveProperty(HEADER_STEP_CLIENT_ID);

    // An empty string is a real value (an unknown owner), so it still stamps —
    // mirroring buildLifecycleHeaders' always-present run-client-id.
    const empty = buildStepHeaders({
      runId: 'run-1',
      stepId: 'step-0',
      runClientId: '',
      stepClientId: '',
    });
    expect(empty[HEADER_RUN_CLIENT_ID]).toBe('');
    expect(empty[HEADER_STEP_CLIENT_ID]).toBe('');
  });
});

describe('isStepLifecycleName', () => {
  it('recognises the two step-lifecycle names and nothing else', () => {
    expect(isStepLifecycleName(EVENT_STEP_START)).toBe(true);
    expect(isStepLifecycleName(EVENT_STEP_END)).toBe(true);
    expect(isStepLifecycleName(EVENT_RUN_START)).toBe(false);
    expect(isStepLifecycleName('ai-output')).toBe(false);
    const noName: string | undefined = undefined;
    expect(isStepLifecycleName(noName)).toBe(false);
  });
});

describe('parseStepLifecycle', () => {
  it('parses a step-start carrying runId, stepId, the client scopes, and serial (its identity)', () => {
    const event = parseStepLifecycle(
      EVENT_STEP_START,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_STEP_ID]: 'step-0',
        [HEADER_INVOCATION_ID]: 'inv-1',
        [HEADER_RUN_CLIENT_ID]: 'owner',
        [HEADER_INPUT_CLIENT_ID]: 'invoker',
        [HEADER_STEP_CLIENT_ID]: 'stepper',
      },
      's1',
      1000,
    );

    expect(event).toEqual({
      type: 'step-start',
      runId: 'run-1',
      stepId: 'step-0',
      invocationId: 'inv-1',
      runClientId: 'owner',
      invocationClientId: 'invoker',
      stepClientId: 'stepper',
      serial: 's1',
      timestamp: 1000,
    });
  });

  it('parses a step-end with its step-start-serial back-ref, an explicit reason, and the client scopes', () => {
    const event = parseStepLifecycle(
      EVENT_STEP_END,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_STEP_ID]: 'step-0',
        [HEADER_STEP_START_SERIAL]: 's1',
        [HEADER_INVOCATION_ID]: 'inv-1',
        [HEADER_RUN_CLIENT_ID]: 'owner',
        [HEADER_INPUT_CLIENT_ID]: 'invoker',
        [HEADER_STEP_CLIENT_ID]: 'stepper',
        [HEADER_STEP_REASON]: 'failed',
      },
      's2',
      2000,
    );

    expect(event).toEqual({
      type: 'step-end',
      runId: 'run-1',
      stepId: 'step-0',
      stepStartSerial: 's1',
      invocationId: 'inv-1',
      runClientId: 'owner',
      invocationClientId: 'invoker',
      stepClientId: 'stepper',
      serial: 's2',
      timestamp: 2000,
      reason: 'failed',
    });
  });

  it('defaults a missing step-end reason to "complete", empty client scopes, and undefined serial/timestamp', () => {
    const noSerial: string | undefined = undefined;
    const noTimestamp: number | undefined = undefined;
    const event = parseStepLifecycle(
      EVENT_STEP_END,
      { [HEADER_RUN_ID]: 'run-1', [HEADER_STEP_ID]: 'step-0', [HEADER_STEP_START_SERIAL]: 's1' },
      noSerial,
      noTimestamp,
    );

    expect(event).toEqual({
      type: 'step-end',
      runId: 'run-1',
      stepId: 'step-0',
      stepStartSerial: 's1',
      // Absent client-scope headers parse to the empty string (mirrors the
      // run-lifecycle parser's clientId/invocationId default).
      invocationId: '',
      runClientId: '',
      invocationClientId: '',
      stepClientId: '',
      serial: undefined,
      reason: 'complete',
    });
  });

  it('returns undefined when run-id or step-id is missing', () => {
    expect(parseStepLifecycle(EVENT_STEP_START, { [HEADER_STEP_ID]: 's' }, 's1', 1)).toBeUndefined();
    expect(parseStepLifecycle(EVENT_STEP_START, { [HEADER_RUN_ID]: 'r' }, 's1', 1)).toBeUndefined();
  });

  it('returns undefined for a step-end missing its step-start-serial back-ref', () => {
    expect(
      parseStepLifecycle(EVENT_STEP_END, { [HEADER_RUN_ID]: 'r', [HEADER_STEP_ID]: 's' }, 's2', 1),
    ).toBeUndefined();
  });

  it('parses a step-start even with no step-start-serial header (its own serial is the identity)', () => {
    const event = parseStepLifecycle(EVENT_STEP_START, { [HEADER_RUN_ID]: 'r', [HEADER_STEP_ID]: 's' }, 's1', 1);
    expect(event).toMatchObject({ type: 'step-start', runId: 'r', stepId: 's', serial: 's1' });
  });

  it('returns undefined for a non-step message name', () => {
    expect(
      parseStepLifecycle(
        EVENT_RUN_START,
        { [HEADER_RUN_ID]: 'run-1', [HEADER_STEP_ID]: 'step-0', [HEADER_STEP_START_SERIAL]: 's1' },
        's1',
        1000,
      ),
    ).toBeUndefined();
  });
});
