// @vitest-environment jsdom

/**
 * ChatTransportProvider: the Vercel bridge over the generic
 * ClientTransportProvider. It builds one useChat adapter per client
 * transport, forwards the route options, closes an adapter its successor
 * replaces (and any adapter a discarded Strict Mode render created), and
 * surfaces the generic provider's construction error through the slot.
 */

import { renderHook } from '@testing-library/react';
import type * as Ably from 'ably';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { ChatTransportProvider } from '../../../src/vercel/react/contexts/chat-transport-provider.js';
import { useChatTransport } from '../../../src/vercel/react/use-chat-transport.js';
import type { ChatTransport, ChatTransportOptions } from '../../../src/vercel/transport/chat-transport.js';

/** Inert unsubscribe for the fake transport's events. */
const noopUnsubscribe = (): void => {
  /* inert */
};

/**
 * Minimal channels.get stub: the provider only threads the channel through.
 * @param name - The requested channel name.
 * @param options - The resolved channel options.
 * @returns A stub carrying both, standing in for the channel.
 */
const channelsGet = (name: string, options?: Ably.ChannelOptions): unknown => ({ name, options });

vi.mock('ably/react', async () => {
  const { createElement: h, Fragment } = await import('react');
  return {
    useAbly: () => ({ channels: { get: channelsGet } }),
    ChannelProvider: ({ children }: { children?: ReactNode }) => h(Fragment, undefined, children),
  };
});

const createClientTransportMock = vi.hoisted(() => vi.fn<(options: unknown) => unknown>());
vi.mock('../../../src/core/transport/client-transport.js', () => ({
  createClientTransport: (options: unknown) => createClientTransportMock(options),
}));

/** One recorded adapter creation: the options passed and the fake returned. */
interface CreatedAdapter {
  /** The options `createChatTransport` was called with. */
  options: ChatTransportOptions;
  /** The fake adapter, exposing its close count. */
  adapter: ChatTransport & { closeCalls: number };
}

const createdAdapters = vi.hoisted(() => [] as { options: unknown; adapter: { closeCalls: number } }[]);
vi.mock('../../../src/vercel/transport/chat-transport.js', () => ({
  createChatTransport: (options: unknown) => {
    const adapter = {
      closeCalls: 0,
      close(): void {
        this.closeCalls += 1;
      },
    };
    createdAdapters.push({ options, adapter });
    return adapter;
  },
}));

/**
 * The recorded creations, typed for assertions.
 * @returns Every adapter creation the mocked factory recorded, in order.
 */
const created = (): CreatedAdapter[] =>
  // CAST: the mock records what the bridge passed; the tests read known fields.
  createdAdapters as unknown as CreatedAdapter[];

const createFakeTransport = (): ClientTransport<unknown, unknown> =>
  // CAST: the provider calls only the members stubbed here.
  ({
    connect: async () => {
      /* connected */
      await Promise.resolve();
    },
    subscribe: () => noopUnsubscribe,
    on: () => noopUnsubscribe,
    close: () => {
      /* closed */
    },
  }) as unknown as ClientTransport<unknown, unknown>;

const wrap =
  (props: { channelName: string; api?: string; strict?: boolean }) =>
  ({ children }: { children: ReactNode }): ReactNode => {
    const provider = createElement(
      ChatTransportProvider,
      {
        channelName: props.channelName,
        ...(props.api === undefined ? {} : { api: props.api }),
      },
      children,
    );
    return props.strict ? createElement(StrictMode, undefined, provider) : provider;
  };

beforeEach(() => {
  vi.clearAllMocks();
  createdAdapters.length = 0;
  createClientTransportMock.mockImplementation(() => createFakeTransport());
});

describe('ChatTransportProvider', () => {
  it('provides the client transport and an adapter built over it', () => {
    const { result } = renderHook(() => useChatTransport(), { wrapper: wrap({ channelName: 'ai:test' }) });

    expect(result.current.transport).toBeDefined();
    expect(result.current.chatTransport).toBeDefined();
    expect(result.current.error).toBeUndefined();
    const creation = created().at(-1);
    expect(creation?.options.transport).toBe(result.current.transport);
    expect(creation?.options.channelName).toBe('ai:test');
  });

  it('forwards the route options to the adapter', () => {
    renderHook(() => useChatTransport(), {
      wrapper: wrap({ channelName: 'ai:test', api: '/api/custom' }),
    });

    const creation = created().at(-1);
    expect(creation?.options.api).toBe('/api/custom');
  });

  it('registers the slot by channel name for a named lookup', () => {
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:test' }), {
      wrapper: wrap({ channelName: 'ai:test' }),
    });

    expect(result.current.chatTransport).toBeDefined();
  });

  it('surfaces a transport construction failure as the slot error, with no adapter', () => {
    createClientTransportMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const { result } = renderHook(() => useChatTransport(), { wrapper: wrap({ channelName: 'ai:test' }) });

    expect(result.current.transport).toBeUndefined();
    expect(result.current.chatTransport).toBeUndefined();
    // This provider re-surfaces whatever ClientTransportProvider classified.
    // A construction failure there is a bad channel name or a closed client —
    // the caller's own input — so it carries InvalidArgument rather than
    // pointing the developer at an SDK fault.
    expect(result.current.error).toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    expect(created()).toHaveLength(0);
  });

  it('closes the replaced adapter when a route option changes on the same transport', () => {
    // The wrapper re-reads this on each render, so rerender() below
    // re-renders the provider with the changed route option.
    const api = { value: '/api/first' };
    const { result, rerender } = renderHook(() => useChatTransport(), {
      wrapper: ({ children }: { children: ReactNode }): ReactNode =>
        wrap({ channelName: 'ai:test', api: api.value })({ children }),
    });
    const first = result.current.chatTransport;

    api.value = '/api/other';
    rerender();

    const creations = created();
    expect(creations).toHaveLength(2);
    expect(result.current.chatTransport).not.toBe(first);
    expect(creations[0]?.adapter.closeCalls).toBe(1);
    expect(creations[1]?.adapter.closeCalls).toBe(0);
    // The same transport backs both adapters — only the adapter was rebuilt.
    expect(creations[0]?.options.transport).toBe(creations[1]?.options.transport);
  });

  it('closes the surviving adapter on unmount', async () => {
    const { result, unmount } = renderHook(() => useChatTransport(), {
      wrapper: wrap({ channelName: 'ai:test' }),
    });
    const adapter = result.current.chatTransport;

    unmount();
    // The close is deferred a microtask so Strict Mode's remount can cancel
    // it; a real unmount has no remount, so it lands.
    await Promise.resolve();

    // Closing the underlying transport is not enough: only the adapter's own
    // close terminates the readers useChat holds.
    expect(created().find(({ adapter: a }) => a === adapter)?.adapter.closeCalls).toBe(1);
  });

  it('creates exactly one live adapter under Strict Mode, closing any discarded creation', () => {
    const { result } = renderHook(() => useChatTransport(), {
      wrapper: wrap({ channelName: 'ai:test', strict: true }),
    });

    const live = created().filter(({ adapter }) => adapter.closeCalls === 0);
    expect(live).toHaveLength(1);
    expect(result.current.chatTransport).toBe(live[0]?.adapter);
  });
});
