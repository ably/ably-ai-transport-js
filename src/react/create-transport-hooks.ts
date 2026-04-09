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
 *   useSend,
 *   useActiveTurns,
 * } = createTransportHooks<UIMessageChunk, UIMessage>();
 *
 * // In page:
 * <TransportProvider channelName="ai:demo" codec={UIMessageCodec}>
 *   <Chat />
 * </TransportProvider>
 *
 * // In Chat — no type params needed:
 * const transport = useClientTransport('ai:demo');
 * const { nodes } = useView(transport, { limit: 30 });
 * const send = useSend(transport);
 */

import type * as Ably from 'ably';
import type { ComponentType } from 'react';

import type { ActiveTurn, ClientTransport, SendOptions } from '../core/transport/types.js';
import type { TransportProviderProps } from './contexts/transport-provider.js';
import { TransportProvider as _TransportProvider } from './contexts/transport-provider.js';
import { useAblyMessages as _useAblyMessages } from './use-ably-messages.js';
import { useActiveTurns as _useActiveTurns } from './use-active-turns.js';
import { useClientTransport as _useClientTransport } from './use-client-transport.js';
import { useEdit as _useEdit } from './use-edit.js';
import { useRegenerate as _useRegenerate } from './use-regenerate.js';
import { useSend as _useSend } from './use-send.js';
import type { TreeHandle } from './use-tree.js';
import { useTree as _useTree } from './use-tree.js';
import type { ViewHandle, ViewOptions } from './use-view.js';
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
   * @param channelName - The channel name passed to the enclosing `TransportProvider`.
   * @throws {Ably.ErrorInfo} if no `TransportProvider` with the given `channelName` is in the tree.
   */
  useClientTransport: (channelName: string) => ClientTransport<TEvent, TMessage>;
  /**
   * Subscribe to the transport's view and return the visible node list with pagination.
   * @param transport - The transport to read from.
   * @param options - When provided, auto-loads the first page on mount.
   */
  useView: (
    transport: ClientTransport<TEvent, TMessage> | null | undefined,
    options?: ViewOptions | null,
  ) => ViewHandle<TMessage>;
  /**
   * Return a stable `send` callback.
   * The returned function sends messages and returns an {@link ActiveTurn} handle.
   * @param transport - The transport to send through.
   */
  useSend: (
    transport: ClientTransport<TEvent, TMessage>,
  ) => (messages: TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>;
  /**
   * Track active turns across all clients on the channel.
   * @param transport - The transport to observe.
   */
  useActiveTurns: (transport: ClientTransport<TEvent, TMessage> | null | undefined) => Map<string, Set<string>>;
  /**
   * Navigate conversation branches in the transport tree.
   * @param transport - The transport to read from.
   */
  useTree: (transport: ClientTransport<TEvent, TMessage>) => TreeHandle<TMessage>;
  /**
   * Return a stable `regenerate` callback.
   * The returned function regenerates the given message and returns an {@link ActiveTurn} handle.
   * @param transport - The transport to send through.
   */
  useRegenerate: (
    transport: ClientTransport<TEvent, TMessage>,
  ) => (messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>;
  /**
   * Return a stable `edit` callback.
   * The returned function edits the given message and returns an {@link ActiveTurn} handle.
   * @param transport - The transport to send through.
   */
  useEdit: (
    transport: ClientTransport<TEvent, TMessage>,
  ) => (messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>;
  /**
   * Subscribe to raw Ably messages on the transport channel.
   * @param transport - The transport to observe.
   */
  useAblyMessages: (transport: ClientTransport<TEvent, TMessage>) => Ably.InboundMessage[];
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
  useClientTransport: (channelName: string) => _useClientTransport<TEvent, TMessage>(channelName),
  useView: (transport, options) => _useView(transport, options),
  useSend: (transport) => _useSend(transport),
  useActiveTurns: (transport) => _useActiveTurns(transport),
  useTree: (transport) => _useTree(transport),
  useRegenerate: (transport) => _useRegenerate(transport),
  useEdit: (transport) => _useEdit(transport),
  useAblyMessages: (transport) => _useAblyMessages(transport),
});
