/**
 * The Vercel transport wrappers: `createClientTransport` / `createAgentTransport`
 * pre-bound to the Vercel wire codec — the caller supplies a channel and no
 * codec.
 */

import { describe, expect, it } from 'vitest';

import { createAgentTransport, createClientTransport } from '../../../src/vercel/transport/index.js';
import { createMockChannel } from '../../helper/mock-channel.js';

describe('Vercel createClientTransport', () => {
  it('creates a connectable client transport with the codec pre-bound', async () => {
    const channel = createMockChannel();
    const transport = createClientTransport({ channel });
    await transport.connect();

    const sent = await transport.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    });

    expect(sent.transportMessageId).toBeTruthy();
    expect(channel.publishCalls.length).toBeGreaterThan(0);
    transport.close();
  });
});

describe('Vercel createAgentTransport', () => {
  it('creates a connectable agent transport with the codec pre-bound', async () => {
    const channel = createMockChannel();
    const transport = createAgentTransport({ channel });
    await transport.connect();

    const run = transport.openRun({ runId: 'run-1' });
    await run.end({ reason: 'complete' });

    expect(channel.publishCalls.some((m) => m.name === 'ai-run-resume')).toBe(true);
    transport.close();
  });
});
