/**
 * createTransportHooks: factory that captures TEvent and TMessage once and returns
 * a bundle of type-safe hooks + TransportProvider. Hook call sites need no type
 * parameters at every use — just call the hooks directly.
 * @example
 * // Once per app (e.g. in a shared transport.ts):
 * export const {
 *   TransportProvider,
 *   useClientTransport,
 *   useView,
 *   useActiveTurns,
 * } = createTransportHooks<UIMessageChunk, UIMessage>();
 *
 * // In page:
 * <TransportProvider channelName="ai:demo" codec={UIMessageCodec}>
 *   <Chat />
 * </TransportProvider>
 *
 * // In Chat — no type params needed, transport is implicit from nearest provider:
 * const { nodes } = useView({ limit: 30 });
 * const turns = useActiveTurns();
 */

import type * as Ably from 'ably';
import type { ComponentType } from 'react';

import type { TransportProviderProps } from './contexts/transport-provider.js';
import { TransportProvider as _TransportProvider } from './contexts/transport-provider.js';
import type { UseAblyMessagesOptions } from './use-ably-messages.js';
import { useAblyMessages as _useAblyMessages } from './use-ably-messages.js';
import type { UseActiveTurnsOptions } from './use-active-turns.js';
import { useActiveTurns as _useActiveTurns } from './use-active-turns.js';
import type { ClientTransportHandle, UseClientTransportOptions } from './use-client-transport.js';
import { useClientTransport as _useClientTransport } from './use-client-transport.js';
import type { UseCreateViewOptions } from './use-create-view.js';
import { useCreateView as _useCreateView } from './use-create-view.js';
import type { TreeHandle, UseTreeOptions } from './use-tree.js';
import { useTree as _useTree } from './use-tree.js';
import type { UseViewOptions, ViewHandle } from './use-view.js';
import { useView as _useView } from './use-view.js';

/**
 * Bundle of type-safe hooks and provider returned by {@link createTransportHooks}.
 *
 * `TEvent` and `TMessage` are baked in at factory creation time so no type params
 * are needed at hook call sites.
 */
export interface TransportHooks<TEvent, TMessage> {
  /**
   * `TransportProvider` narrowed to `TEvent`/`TMessage`. No JSX type params needed.
   */
  TransportProvider: ComponentType<TransportProviderProps<TEvent, TMessage>>;
  /**
   * Read the transport from context. No type params needed.
   *
   * Returns `{ transport, transportError }`. When no provider is found,
   * `transportError` is set and `transport` is a stub that throws on access —
   * the hook never throws during render.
   *
   * Pass `onError` to subscribe to post-construction transport errors
   * (e.g. send failures, channel continuity loss) without wiring
   * `transport.on('error', …)` manually.
   */
  useClientTransport: (props?: UseClientTransportOptions) => ClientTransportHandle<TEvent, TMessage>;
  /**
   * Subscribe to the nearest transport's view and return the visible node list with pagination.
   * Pass `transport` to use a transport's default view, `view` to subscribe to a specific view
   * directly. Pass `limit` to auto-load on mount. Pass `skip: true` for an empty handle.
   */
  useView: (props?: UseViewOptions<TEvent, TMessage>) => ViewHandle<TEvent, TMessage>;
  /**
   * Track active turns across all clients on the channel.
   * Pass `transport` to override; defaults to the nearest {@link TransportProvider}.
   */
  useActiveTurns: (props?: UseActiveTurnsOptions<TEvent, TMessage>) => Map<string, Set<string>>;
  /**
   * Navigate conversation branches in the transport tree.
   * Pass `transport` to override; defaults to the nearest {@link TransportProvider}.
   */
  useTree: (props?: UseTreeOptions<TEvent, TMessage>) => TreeHandle<TMessage>;
  /**
   * Subscribe to raw Ably messages on the transport channel.
   * Pass `transport` to override; defaults to the nearest {@link TransportProvider}.
   * Pass `skip: true` to return an empty array without subscribing.
   */
  useAblyMessages: (props?: UseAblyMessagesOptions<TEvent, TMessage>) => Ably.InboundMessage[];
  /**
   * Create an independent view over the same tree.
   * Pass `transport` to override; defaults to the nearest {@link TransportProvider}.
   * Pass `skip: true` to return an empty handle without creating a view.
   */
  useCreateView: (props?: UseCreateViewOptions<TEvent, TMessage>) => ViewHandle<TEvent, TMessage>;
}

/**
 * Create a bundle of type-safe hooks and provider for a given `TEvent`/`TMessage` pair.
 *
 * `TEvent` and `TMessage` are captured at factory creation time; hook call sites need
 * no type parameters. The returned hooks are thin wrappers around the standalone hooks
 * with the types resolved.
 * @returns A {@link TransportHooks} bundle.
 */
export const createTransportHooks = <TEvent, TMessage>(): TransportHooks<TEvent, TMessage> => ({
  // CAST: TransportProvider is generic; factory narrows it to TEvent/TMessage.
  TransportProvider: _TransportProvider as ComponentType<TransportProviderProps<TEvent, TMessage>>,
  useClientTransport: (props) => _useClientTransport<TEvent, TMessage>(props ?? {}),
  useView: (props) => _useView<TEvent, TMessage>(props ?? {}),
  useActiveTurns: (props) => _useActiveTurns<TEvent, TMessage>(props ?? {}),
  useTree: (props) => _useTree<TEvent, TMessage>(props ?? {}),
  useAblyMessages: (props) => _useAblyMessages<TEvent, TMessage>(props ?? {}),
  useCreateView: (props) => _useCreateView<TEvent, TMessage>(props ?? {}),
});
