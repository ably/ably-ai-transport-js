import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ClientRun } from '@ably/ai-transport';
import type { VercelSessionInput } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';

import { userMessage, wakeAgent } from '../index';

describe('userMessage', () => {
  it('creates a UIMessage with role "user"', () => {
    const msg = userMessage('hello');
    expect(msg.role).toBe('user');
  });

  it('creates a single text part with the given text', () => {
    const msg = userMessage('hello world');
    expect(msg.parts).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('generates a unique id for each message', () => {
    const msg1 = userMessage('a');
    const msg2 = userMessage('b');
    expect(msg1.id).toBeTruthy();
    expect(msg2.id).toBeTruthy();
    expect(msg1.id).not.toBe(msg2.id);
  });
});

describe('wakeAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the run invocation JSON to the endpoint and returns the minted ids', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ runId: 'run-1', invocationId: 'inv-1' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    // CAST: wakeAgent reads only `run.toInvocation().toJSON()`; build the minimal
    // ClientRun surface it touches and assert the type.
    const run = {
      toInvocation: () => ({ toJSON: () => ({ inputEventId: 'ev-1', sessionName: 'demo' }) }),
    } as unknown as ClientRun<VercelSessionInput, UIMessage>;

    const result = await wakeAgent('/api/chat', run);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/chat');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ inputEventId: 'ev-1', sessionName: 'demo' });
    expect(result).toEqual({ runId: 'run-1', invocationId: 'inv-1' });
  });
});
