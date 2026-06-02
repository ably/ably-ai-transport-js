import { describe, expect, it } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import { buildTransportHeaders, parseRunLifecycle } from '../../../src/core/transport/headers.js';

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

  it('omits run-id when runId is undefined (agent-minted fresh send)', () => {
    // A fresh client send carries no run-id — the agent assigns it.
    const headers = buildTransportHeaders({
      role: 'user',
      codecMessageId: 'msg-1',
    });

    expect(headers).not.toHaveProperty(HEADER_RUN_ID);
    expect(headers[HEADER_ROLE]).toBe('user');
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
        [HEADER_RUN_CONTINUE]: 'true',
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
      isContinuation: true,
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
    expect(event).not.toHaveProperty('isContinuation');
  });

  it('does not mark isContinuation when run-continue is not "true"', () => {
    const event = parseRunLifecycle(
      EVENT_RUN_START,
      { [HEADER_RUN_ID]: 'run-1', [HEADER_RUN_CONTINUE]: 'false' },
      's1',
    );

    expect(event).not.toHaveProperty('isContinuation');
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

  it('returns undefined when run-id is missing', () => {
    expect(parseRunLifecycle(EVENT_RUN_START, {}, 's1')).toBeUndefined();
    expect(parseRunLifecycle(EVENT_RUN_END, {}, 's1')).toBeUndefined();
  });

  it('returns undefined for a non-lifecycle message name', () => {
    expect(parseRunLifecycle('ai-output', { [HEADER_RUN_ID]: 'run-1' }, 's1')).toBeUndefined();
  });
});
