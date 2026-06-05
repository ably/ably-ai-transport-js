// @vitest-environment jsdom

import { act, render, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Flush microtasks (but NOT macrotasks) so deferred promises resolve. */
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

import type { CodecInputEvent, CodecOutputEvent } from '../../../src/core/codec/types.js';
import type { ClientSession } from '../../../src/core/transport/types.js';
import { ClientSessionProvider } from '../../../src/react/contexts/client-session-provider.js';
import { useClientSession } from '../../../src/react/use-client-session.js';
import { createMockSession } from '../helper/mock-session.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stand-in Realtime client returned by the mocked `useAbly()`. The provider
// passes it straight through to createClientSession (which is itself mocked),
// so the shape only needs to satisfy TypeScript.
const fakeAblyClient = { options: {} } as unknown as Ably.Realtime;

vi.mock('ably/react', () => ({
  useAbly: () => fakeAblyClient,
}));

// Typed with explicit parameter signature so mock.calls[0] is [unknown], enabling assertions
const createClientSessionMock =
  vi.fn<(options: unknown) => ClientSession<CodecInputEvent, CodecOutputEvent, unknown, unknown>>();

vi.mock('../../../src/core/transport/client-session.js', () => ({
  createClientSession: (options: unknown) => createClientSessionMock(options),
}));

// ---------------------------------------------------------------------------
// Wrapper helpers — defined at module scope to satisfy unicorn/consistent-function-scoping.
// Use // comments (not JSDoc) so jsdoc/require-param does not fire.
// ---------------------------------------------------------------------------

// ClientSessionProvider on channelName "ai:test".
const wrapDefault = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(
    ClientSessionProvider<CodecInputEvent, CodecOutputEvent, unknown, unknown>,
    { channelName: 'ai:test', codec: {} as never },
    children,
  );

// ClientSessionProvider with channelName "ai:demo" for channel-name forwarding test.
const wrapDemo = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(
    ClientSessionProvider<CodecInputEvent, CodecOutputEvent, unknown, unknown>,
    { channelName: 'ai:demo', codec: {} as never },
    children,
  );

// Nested outer (channelName="ai:outer") + inner (channelName="ai:inner") ClientSessionProvider pair.
const wrapNested = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(
    ClientSessionProvider<CodecInputEvent, CodecOutputEvent, unknown, unknown>,
    { channelName: 'ai:outer', codec: {} as never },
    createElement(
      ClientSessionProvider<CodecInputEvent, CodecOutputEvent, unknown, unknown>,
      { channelName: 'ai:inner', codec: {} as never },
      children,
    ),
  );

// ClientSessionProvider with a parametric channelName, used by the channel-name change test.
const renderProviderForChannel = (channelName: string): ReactNode =>
  createElement(ClientSessionProvider<CodecInputEvent, CodecOutputEvent, unknown, unknown>, {
    channelName,
    codec: {} as never,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientSessionProvider', () => {
  beforeEach(() => {
    createClientSessionMock.mockClear();
    createClientSessionMock.mockImplementation(() => createMockSession().session);
  });

  it('creates a session and makes it available via useClientSession(channelName)', () => {
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    expect(result.current).toBeDefined();
    expect(createClientSessionMock).toHaveBeenCalledTimes(1);
  });

  it('passes channelName and the Ably client to createClientSession', () => {
    renderHook(() => useClientSession({ channelName: 'ai:demo' }), { wrapper: wrapDemo });

    // CAST: wire-boundary assertion — vitest types mock args as unknown
    const callArgs = createClientSessionMock.mock.calls[0]?.[0] as { channelName: string; client: Ably.Realtime };
    expect(callArgs.channelName).toBe('ai:demo');
    expect(callArgs.client).toBe(fakeAblyClient);
  });

  it('registers the session under channelName', () => {
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    expect(result.current).toBeDefined();
  });

  it('sets sessionError when no ClientSessionProvider is in the tree', () => {
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }));
    expect(result.current.sessionError).toMatchObject({ code: 40000 });
  });

  it('surfaces construction error as sessionError when createClientSession throws', () => {
    const constructionError = new Ably.ErrorInfo('unable to create session; codec is invalid', 40003, 400);
    createClientSessionMock.mockImplementationOnce(() => {
      throw constructionError;
    });

    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapDefault });

    expect(result.current.sessionError).toBe(constructionError);
    // session is a stub that throws on access
    expect(() => result.current.session.tree).toThrow();
  });

  it('does not retry session creation on re-renders after a constructor error', () => {
    const constructionError = new Ably.ErrorInfo('unable to create session; codec is invalid', 40003, 400);
    createClientSessionMock.mockImplementation(() => {
      throw constructionError;
    });

    const { result, rerender } = renderHook(() => useClientSession({ channelName: 'ai:test' }), {
      wrapper: wrapDefault,
    });

    expect(createClientSessionMock).toHaveBeenCalledTimes(1);
    expect(result.current.sessionError).toBe(constructionError);

    act(() => {
      rerender();
    });
    act(() => {
      rerender();
    });

    // No retry — createClientSession still called exactly once.
    expect(createClientSessionMock).toHaveBeenCalledTimes(1);
    expect(result.current.sessionError).toBe(constructionError);
  });

  it('creates the session exactly once across re-renders', () => {
    const { rerender } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    act(() => {
      rerender();
    });
    act(() => {
      rerender();
    });

    expect(createClientSessionMock).toHaveBeenCalledTimes(1);
  });

  it('stacks two nested providers so both sessions are accessible', () => {
    const { result: outerResult } = renderHook(() => useClientSession({ channelName: 'ai:outer' }), {
      wrapper: wrapNested,
    });
    const { result: innerResult } = renderHook(() => useClientSession({ channelName: 'ai:inner' }), {
      wrapper: wrapNested,
    });

    expect(outerResult.current).toBeDefined();
    expect(innerResult.current).toBeDefined();
    expect(outerResult.current).not.toBe(innerResult.current);
  });

  it('closes the session when the provider unmounts', async () => {
    const created: ReturnType<typeof createMockSession>[] = [];
    createClientSessionMock.mockImplementation(() => {
      const mock = createMockSession();
      created.push(mock);
      return mock.session;
    });

    const { unmount } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    unmount();
    await flushMicrotasks();

    expect(created[0]?.close).toHaveBeenCalledOnce();
  });

  it('defers the session close to a microtask so a Strict Mode remount can cancel it', async () => {
    const created: ReturnType<typeof createMockSession>[] = [];
    createClientSessionMock.mockImplementation(() => {
      const mock = createMockSession();
      created.push(mock);
      return mock.session;
    });

    const { unmount } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    unmount();

    // close() is NOT run synchronously on unmount — it is scheduled as a
    // microtask. This is the mechanism that makes the provider safe under React
    // Strict Mode: the synchronous mount -> unmount -> remount cycle resets
    // pendingCloseRef before the microtask drains, cancelling the close. Since
    // close() now detaches the channel (see client-session.test.ts "detaches
    // the channel it attached"), this deferral is what prevents a spurious
    // channel detach during the Strict Mode remount.
    expect(created[0]?.close).not.toHaveBeenCalled();

    await flushMicrotasks();

    // On a genuine unmount (nothing remounts to reset the guard) the deferred
    // close runs exactly once, detaching the channel the session attached.
    expect(created[0]?.close).toHaveBeenCalledOnce();
  });

  it('connects the new session and closes the old one when channelName changes', async () => {
    const created: ReturnType<typeof createMockSession>[] = [];
    createClientSessionMock.mockImplementation(() => {
      const mock = createMockSession();
      created.push(mock);
      return mock.session;
    });

    const { rerender } = render(renderProviderForChannel('ai:a'));

    expect(created).toHaveLength(1);
    expect(created[0]?.connect).toHaveBeenCalledTimes(1);

    rerender(renderProviderForChannel('ai:b'));
    await flushMicrotasks();

    expect(created).toHaveLength(2);
    expect(created[1]?.connect).toHaveBeenCalledTimes(1);
    expect(created[0]?.close).toHaveBeenCalled();
  });

  it('forwards session options to createClientSession', () => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(),
    };

    // wrapper closes over `logger` — unicorn/consistent-function-scoping does not fire for closures
    const wrapWithLogger = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        ClientSessionProvider<CodecInputEvent, CodecOutputEvent, unknown, unknown>,
        { channelName: 'ai:test', codec: {} as never, clientId: 'client-x', logger },
        children,
      );

    renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper: wrapWithLogger });

    // CAST: accessing vitest mock call args as the known options type
    const callArgs = createClientSessionMock.mock.calls[0]?.[0] as { clientId: string; logger: unknown };
    expect(callArgs.clientId).toBe('client-x');
    expect(callArgs.logger).toBe(logger);
  });
});
