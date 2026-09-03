/**
 * Tests for the shared hydration pass: store-then-walk ordering, the dedupe at
 * the seam, the once-per-adapter cache Strict Mode needs, and the two failure
 * paths (no adapter, and a rejected pass that a later mount must be able to
 * retry).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import type { UIMessage } from 'ai';
import type { WalkedMessage } from '@ably/ai-transport/vercel';

let fakeTransport: { connect: ReturnType<typeof vi.fn> } | undefined;
let fakeChatTransport: { readSince: ReturnType<typeof vi.fn> } | undefined;
let providerError: Error | undefined;

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    transport: fakeTransport,
    chatTransport: fakeChatTransport,
    error: providerError,
  }),
}));

// Imported AFTER vi.mock so the hook picks up the mocked provider reader.

import { useChannelHydration, type UseChannelHydrationOptions } from '../use-channel-hydration';

const strictModeWrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

const message = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: id }] });

/** What the walk returns for a client turn: one `message` input, as the wire carried it. */
const group = (id: string): WalkedMessage => ({
  id,
  events: [{ direction: 'input', event: { kind: 'message', payload: message(id) } }],
});

const walked = (ids: string[], exhausted: boolean) =>
  vi.fn().mockResolvedValue({ messages: ids.map(group), exhausted });

const renderHydration = (options: UseChannelHydrationOptions = {}) =>
  renderHook(() => useChannelHydration(options), { wrapper: strictModeWrapper });

describe('useChannelHydration', () => {
  beforeEach(() => {
    // A fresh adapter per test: the pass is cached per adapter instance.
    fakeTransport = { connect: vi.fn(async () => undefined) };
    fakeChatTransport = { readSince: walked([], true) };
    providerError = undefined;
  });

  it('walks the whole channel when the demo keeps no store', async () => {
    if (!fakeChatTransport) throw new Error('no adapter');
    fakeChatTransport.readSince = walked(['m1'], true);

    const { result } = renderHydration();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['m1']);
    expect(result.current.hasOlder).toBe(false);
    expect(fakeChatTransport.readSince).toHaveBeenCalledWith(undefined);
  });

  it('reads the store first and walks from the serial it reports', async () => {
    if (!fakeChatTransport) throw new Error('no adapter');
    fakeChatTransport.readSince = walked(['m2'], false);
    const loadStored = vi.fn().mockResolvedValue({ messages: [message('m1')], latestSerial: '01ABC@7' });

    const { result } = renderHydration({ loadStored });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(result.current.hasOlder).toBe(true);
    expect(fakeChatTransport.readSince).toHaveBeenCalledWith('01ABC@7');
  });

  it('drops a walked message the store already holds', async () => {
    if (!fakeChatTransport) throw new Error('no adapter');
    // The watermark is a lower bound, so the walk can re-return a stored turn.
    fakeChatTransport.readSince = walked(['m1', 'm2'], true);
    const loadStored = vi.fn().mockResolvedValue({ messages: [message('m1')], latestSerial: '01ABC@7' });

    const { result } = renderHydration({ loadStored });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('walks once per adapter, even though Strict Mode runs the effect twice', async () => {
    if (!fakeChatTransport) throw new Error('no adapter');
    const { result } = renderHydration();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // A second walk would advance the transport's shared history cursor past
    // the window the first one covered.
    expect(fakeChatTransport.readSince).toHaveBeenCalledTimes(1);
  });

  it('reports an error and never walks when the provider yields no adapter', async () => {
    fakeChatTransport = undefined;
    providerError = new Error('construction failed');

    const { result } = renderHydration();

    await waitFor(() => expect(result.current.status).toBe('error'));
    if (result.current.status !== 'error') throw new Error('expected error');
    expect(result.current.error.message).toBe('construction failed');
  });

  it('evicts a failed pass so a later mount retries it', async () => {
    if (!fakeChatTransport) throw new Error('no adapter');
    const readSince = vi
      .fn()
      .mockRejectedValueOnce(new Error('walk failed'))
      .mockResolvedValue({ messages: [group('m1')], exhausted: true });
    fakeChatTransport.readSince = readSince;

    const first = renderHydration();
    await waitFor(() => expect(first.result.current.status).toBe('error'));
    first.unmount();

    const second = renderHydration();
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    if (second.result.current.status !== 'ready') throw new Error('expected ready');
    expect(second.result.current.initialMessages.map((m) => m.id)).toEqual(['m1']);
  });
});
