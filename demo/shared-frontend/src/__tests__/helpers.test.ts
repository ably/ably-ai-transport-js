import { describe, expect, it, vi, afterEach } from 'vitest';

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

  it('POSTs the invocation pointer as JSON and returns the run-id', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ runId: 'run-1' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await wakeAgent('/api/chat', { channelName: 'ai:demo', eventId: 'ev-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/chat');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ channelName: 'ai:demo', eventId: 'ev-1' });
    expect(result).toEqual({ runId: 'run-1' });
  });

  it('includes runId in the body when continuing an existing run', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ runId: 'run-2' })));
    vi.stubGlobal('fetch', fetchMock);

    await wakeAgent('/api/chat', { channelName: 'ai:demo', eventId: 'ev-2', runId: 'run-2' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ channelName: 'ai:demo', eventId: 'ev-2', runId: 'run-2' });
  });
});
