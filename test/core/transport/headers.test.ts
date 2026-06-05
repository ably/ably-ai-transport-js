import { describe, expect, it } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_TRANSPORT_MESSAGE_ID,
} from '../../../src/constants.js';
import {
  buildLifecycleHeaders,
  buildTransportHeaders,
  parseRunLifecycle,
} from '../../../src/core/transport/headers.js';

describe('buildTransportHeaders', () => {
  it('includes role, runId, and transportMessageId', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      transportMessageId: 'msg-1',
    });

    expect(headers[HEADER_ROLE]).toBe('user');
    expect(headers[HEADER_RUN_ID]).toBe('run-1');
    expect(headers[HEADER_TRANSPORT_MESSAGE_ID]).toBe('msg-1');
  });

  it('includes runClientId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      transportMessageId: 'msg-1',
      runClientId: 'user-a',
    });

    expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
  });

  it('includes parent when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      transportMessageId: 'msg-1',
      parent: 'parent-msg',
    });

    expect(headers[HEADER_PARENT]).toBe('parent-msg');
  });

  it('includes forkOf when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      transportMessageId: 'msg-1',
      forkOf: 'fork-msg',
    });

    expect(headers[HEADER_FORK_OF]).toBe('fork-msg');
  });

  it('includes inputClientId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      transportMessageId: 'msg-1',
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
      transportMessageId: 'msg-1',
      inputClientId: '',
    });

    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('');
  });

  it('includes inputTransportMessageId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      runId: 'run-1',
      transportMessageId: 'msg-1',
      inputTransportMessageId: 'trigger-msg',
    });

    expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID]).toBe('trigger-msg');
  });

  it('includes regenerates as msg-regenerate when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      transportMessageId: 'msg-1',
      regenerates: 'asst-original',
    });

    expect(headers[HEADER_MSG_REGENERATE]).toBe('asst-original');
  });

  it('omits optional headers when undefined', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      runId: 'run-1',
      transportMessageId: 'msg-1',
    });

    expect(headers).not.toHaveProperty(HEADER_RUN_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_PARENT);
    expect(headers).not.toHaveProperty(HEADER_FORK_OF);
    expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_ID);
    expect(headers).not.toHaveProperty(HEADER_MSG_REGENERATE);
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
      inputTransportMessageId: 'trigger',
    });
    expect(headers[HEADER_PARENT]).toBe('p');
    expect(headers[HEADER_FORK_OF]).toBe('f');
    expect(headers[HEADER_MSG_REGENERATE]).toBe('g');
    expect(headers[HEADER_INVOCATION_ID]).toBe('inv-1');
    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    expect(headers[HEADER_INPUT_TRANSPORT_MESSAGE_ID]).toBe('trigger');
  });

  it('omits every optional header when not provided', () => {
    const headers = buildLifecycleHeaders({ runId: 'run-1', runClientId: 'user-a' });
    expect(headers).not.toHaveProperty(HEADER_RUN_REASON);
    expect(headers).not.toHaveProperty(HEADER_PARENT);
    expect(headers).not.toHaveProperty(HEADER_FORK_OF);
    expect(headers).not.toHaveProperty(HEADER_MSG_REGENERATE);
    expect(headers).not.toHaveProperty(HEADER_INVOCATION_ID);
    expect(headers).not.toHaveProperty(HEADER_INPUT_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_INPUT_TRANSPORT_MESSAGE_ID);
  });

  it('stamps empty-string correlation values (distinguished from omitted)', () => {
    const headers = buildLifecycleHeaders({ runId: 'run-1', runClientId: '', inputClientId: '' });
    expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('');
  });
});

describe('parseRunLifecycle', () => {
  it('parses a minimal run-start', () => {
    const event = parseRunLifecycle(EVENT_RUN_START, { [HEADER_RUN_ID]: 'run-1' }, 's1');

    expect(event).toEqual({
      type: 'start',
      runId: 'run-1',
      clientId: '',
      serial: 's1',
      invocationId: '',
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
    );

    expect(event).toEqual({
      type: 'start',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's2',
      invocationId: 'inv-1',
      parent: 'parent-msg',
      forkOf: 'fork-msg',
      regenerates: 'asst-original',
    });
  });

  it('omits optional run-start fields when their headers are absent', () => {
    const event = parseRunLifecycle(
      EVENT_RUN_START,
      {
        [HEADER_RUN_ID]: 'run-1',
        [HEADER_RUN_CLIENT_ID]: 'user-a',
        [HEADER_INVOCATION_ID]: 'inv-1',
      },
      's1',
    );

    expect(event).not.toHaveProperty('parent');
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
    );

    expect(event).toEqual({
      type: 'end',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's5',
      invocationId: 'inv-1',
      reason: 'cancelled',
    });
  });

  it('defaults the run-end reason to "complete" and invocationId to "" when absent, and stamps an undefined serial', () => {
    const noSerial: string | undefined = undefined;
    const event = parseRunLifecycle(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1' }, noSerial);

    expect(event).toEqual({
      type: 'end',
      runId: 'run-1',
      clientId: '',
      serial: undefined,
      invocationId: '',
      reason: 'complete',
    });
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
    );

    expect(event).toEqual({
      type: 'suspend',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's4',
      invocationId: 'inv-1',
    });
  });

  it('defaults run-suspend clientId and invocationId to "" when absent and stamps an undefined serial', () => {
    const noSerial: string | undefined = undefined;
    const event = parseRunLifecycle(EVENT_RUN_SUSPEND, { [HEADER_RUN_ID]: 'run-1' }, noSerial);

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
    );

    expect(event).toEqual({
      type: 'resume',
      runId: 'run-1',
      clientId: 'user-a',
      serial: 's6',
      invocationId: 'inv-2',
    });
  });

  it('returns undefined when run-id is missing', () => {
    expect(parseRunLifecycle(EVENT_RUN_START, {}, 's1')).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_SUSPEND, {}, 's1')).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_RESUME, {}, 's1')).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_END, {}, 's1')).toBeUndefined();
  });

  it('returns undefined for a non-lifecycle message name', () => {
    expect(parseRunLifecycle('ai-output', { [HEADER_RUN_ID]: 'run-1' }, 's1')).toBeUndefined();
  });
});
