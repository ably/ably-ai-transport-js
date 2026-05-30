import { describe, expect, it } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';

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
    expect(headers).not.toHaveProperty(HEADER_MSG_REGENERATE);
  });
});
