/**
 * createSessionHooks: factory that captures TEvent and TMessage once and returns
 * a bundle of type-safe hooks + ClientSessionProvider. Hook call sites need no
 * type parameters at every use — just call the hooks directly.
 * @example
 * // Once per app (e.g. in a shared session.ts):
 * export const {
 *   ClientSessionProvider,
 *   useClientSession,
 *   useView,
 *   useActiveRuns,
 * } = createSessionHooks<UIMessageChunk, UIMessage>();
 *
 * // In page:
 * <ClientSessionProvider channelName="ai:demo" codec={UIMessageCodec}>
 *   <Chat />
 * </ClientSessionProvider>
 *
 * // In Chat — no type params needed, session is implicit from nearest provider:
 * const { nodes } = useView({ limit: 30 });
 * const runs = useActiveRuns();
 */

import type * as Ably from 'ably';
import type { ComponentType } from 'react';

import type { ClientSession, View } from '../core/transport/types.js';
import type { ClientSessionProviderProps } from './contexts/client-session-provider.js';
import { ClientSessionProvider as _ClientSessionProvider } from './contexts/client-session-provider.js';
import { useAblyMessages as _useAblyMessages } from './use-ably-messages.js';
import { useActiveRuns as _useActiveRuns } from './use-active-runs.js';
import type { ClientSessionHandle } from './use-client-session.js';
import { useClientSession as _useClientSession } from './use-client-session.js';
import { useCreateView as _useCreateView } from './use-create-view.js';
import type { TreeHandle } from './use-tree.js';
import { useTree as _useTree } from './use-tree.js';
import type { ViewHandle } from './use-view.js';
import { useView as _useView } from './use-view.js';

/**
 * Bundle of type-safe hooks and provider returned by {@link createSessionHooks}.
 *
 * `TEvent` and `TMessage` are baked in at factory creation time so no type params
 * are needed at hook call sites.
 */
export interface SessionHooks<TEvent, TProjection, TMessage> {
  /**
   * `ClientSessionProvider` narrowed to `TEvent`/`TMessage`. No JSX type params needed.
   */
  ClientSessionProvider: ComponentType<ClientSessionProviderProps<TEvent, TProjection, TMessage>>;
  /**
   * Read the session from context. No type params needed.
   *
   * Returns `{ session, sessionError }`. When no provider is found,
   * `sessionError` is set and `session` is a stub that throws on access —
   * the hook never throws during render.
   *
   * Pass `onError` to subscribe to post-construction session errors
   * (e.g. send failures, channel continuity loss) without wiring
   * `session.on('error', …)` manually.
   */
  useClientSession: (props?: {
    /** Channel name to look up; omit to use the nearest {@link ClientSessionProvider}. */
    channelName?: string;
    /** When `true`, return a stub session that throws on any access. */
    skip?: boolean;
    /** Called whenever the resolved session emits an error event. */
    onError?: (error: Ably.ErrorInfo) => void;
  }) => ClientSessionHandle<TEvent, TProjection, TMessage>;
  /**
   * Subscribe to the nearest session's view and return the visible node list with pagination.
   * Pass `session` to use a session's default view, `view` to subscribe to a specific view
   * directly. Pass `limit` to auto-load on mount. Pass `skip: true` for an empty handle.
   */
  useView: (props?: {
    /** Client session whose default view to subscribe to; defaults to the nearest {@link ClientSessionProvider}. */
    session?: ClientSession<TEvent, TProjection, TMessage> | null;
    /** A specific {@link View} to subscribe to directly. Takes priority over `session`. */
    view?: View<TEvent, TProjection, TMessage> | null;
    /** When provided, auto-loads the first page on mount. */
    limit?: number;
    /** When `true`, skip all subscriptions and return an empty handle. */
    skip?: boolean;
  }) => ViewHandle<TEvent, TProjection, TMessage>;
  /**
   * Track active runs across all clients on the channel.
   * Pass `session` to override; defaults to the nearest {@link ClientSessionProvider}.
   */
  useActiveRuns: (props?: {
    /** Override session; defaults to the nearest {@link ClientSessionProvider}. */
    session?: ClientSession<TEvent, TProjection, TMessage> | null;
  }) => Map<string, Set<string>>;
  /**
   * Navigate conversation branches in the session tree.
   * Pass `session` to override; defaults to the nearest {@link ClientSessionProvider}.
   */
  useTree: (props?: {
    /** Override session; defaults to the nearest {@link ClientSessionProvider}. */
    session?: ClientSession<TEvent, TProjection, TMessage>;
  }) => TreeHandle<TMessage>;
  /**
   * Subscribe to raw Ably messages on the session channel.
   * Pass `session` to override; defaults to the nearest {@link ClientSessionProvider}.
   * Pass `skip: true` to return an empty array without subscribing.
   */
  useAblyMessages: (props?: {
    /** Override session; defaults to the nearest {@link ClientSessionProvider}. */
    session?: ClientSession<TEvent, TProjection, TMessage>;
    /** When `true`, skip all subscriptions and return an empty array. */
    skip?: boolean;
  }) => Ably.InboundMessage[];
  /**
   * Create an independent view over the same tree.
   * Pass `session` to override; defaults to the nearest {@link ClientSessionProvider}.
   * Pass `skip: true` to return an empty handle without creating a view.
   */
  useCreateView: (props?: {
    /** Override session; defaults to the nearest {@link ClientSessionProvider}. */
    session?: ClientSession<TEvent, TProjection, TMessage> | null;
    /** When provided, auto-loads the first page on mount. */
    limit?: number;
    /** When `true`, skip view creation and return an empty handle. */
    skip?: boolean;
  }) => ViewHandle<TEvent, TProjection, TMessage>;
}

/**
 * Create a bundle of type-safe hooks and provider for a given `TEvent`/`TMessage` pair.
 *
 * `TEvent` and `TMessage` are captured at factory creation time; hook call sites need
 * no type parameters. The returned hooks are thin wrappers around the standalone hooks
 * with the types resolved.
 * @returns A {@link SessionHooks} bundle.
 */
export const createSessionHooks = <TEvent, TProjection, TMessage>(): SessionHooks<TEvent, TProjection, TMessage> => ({
  // CAST: ClientSessionProvider is generic; factory narrows it to TEvent/TMessage.
  ClientSessionProvider: _ClientSessionProvider as ComponentType<
    ClientSessionProviderProps<TEvent, TProjection, TMessage>
  >,
  useClientSession: (props) => _useClientSession<TEvent, TProjection, TMessage>(props ?? {}),
  useView: (props) => _useView<TEvent, TProjection, TMessage>(props ?? {}),
  useActiveRuns: (props) => _useActiveRuns<TEvent, TProjection, TMessage>(props ?? {}),
  useTree: (props) => _useTree<TEvent, TProjection, TMessage>(props ?? {}),
  useAblyMessages: (props) => _useAblyMessages<TEvent, TProjection, TMessage>(props ?? {}),
  useCreateView: (props) => _useCreateView<TEvent, TProjection, TMessage>(props ?? {}),
});
