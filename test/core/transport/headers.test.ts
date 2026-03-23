import { describe, expect, it } from 'vitest';

import {
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
} from '../../../src/constants.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';

describe('buildTransportHeaders', () => {
  it('includes role, turnId, and msgId', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      turnId: 'turn-1',
      msgId: 'msg-1',
    });

    expect(headers[HEADER_ROLE]).toBe('user');
    expect(headers[HEADER_TURN_ID]).toBe('turn-1');
    expect(headers[HEADER_MSG_ID]).toBe('msg-1');
  });

  it('includes turnClientId when provided', () => {
    const headers = buildTransportHeaders({
      role: 'assistant',
      turnId: 'turn-1',
      msgId: 'msg-1',
      turnClientId: 'user-a',
    });

    expect(headers[HEADER_TURN_CLIENT_ID]).toBe('user-a');
  });

  it('includes parent when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      turnId: 'turn-1',
      msgId: 'msg-1',
      parent: 'parent-msg',
    });

    expect(headers[HEADER_PARENT]).toBe('parent-msg');
  });

  it('includes forkOf when provided', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      turnId: 'turn-1',
      msgId: 'msg-1',
      forkOf: 'fork-msg',
    });

    expect(headers[HEADER_FORK_OF]).toBe('fork-msg');
  });

  it('omits optional headers when undefined', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      turnId: 'turn-1',
      msgId: 'msg-1',
    });

    expect(headers).not.toHaveProperty(HEADER_TURN_CLIENT_ID);
    expect(headers).not.toHaveProperty(HEADER_PARENT);
    expect(headers).not.toHaveProperty(HEADER_FORK_OF);
  });

   
  it('omits parent when null', () => {
    const headers = buildTransportHeaders({
      role: 'user',
      turnId: 'turn-1',
      msgId: 'msg-1',
      parent: null, // eslint-disable-line unicorn/no-null -- explicit null test
    });

    expect(headers).not.toHaveProperty(HEADER_PARENT);
  });
});
