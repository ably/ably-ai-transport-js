/**
 * useMessageSync: wires transport message lifecycle events into useChat's setMessages.
 *
 * Subscribes to the transport view's 'update' event and replaces messages state
 * with the view's authoritative message list.
 *
 * When a ChatTransport is provided (resolved from the nearest ChatTransportProvider),
 * setMessages calls are gated during active own-turn streams. This prevents the
 * push/replace ID mismatch in useChat's write() function. When the stream finishes,
 * the gate opens and an immediate sync fires to pick up any observer messages that
 * arrived during the stream.
 *
 * All dependencies are resolved from the nearest ChatTransportProvider via
 * useChatTransport(). Pass channelName to select a specific provider; omit to use
 * the nearest. Pass skip: true to pause all subscriptions.
 *
 * Returns the unsubscribe function in the useEffect cleanup so handlers
 * are removed on unmount or when dependencies change.
 */

import type * as AI from 'ai';
import { useEffect, useState } from 'react';

import { useChatTransport } from './use-chat-transport.js';

/** Options for {@link useMessageSync}. */
export interface UseMessageSyncOptions {
  /**
   * The `setMessages` updater function from `useChat()`. Required.
   * Called with a function that replaces the previous message list with the
   * transport's current authoritative message list.
   */
  setMessages: (updater: (prev: AI.UIMessage[]) => AI.UIMessage[]) => void;
  /**
   * Channel name of the {@link ChatTransportProvider} to observe.
   * Omit to use the nearest provider in the tree.
   */
  channelName?: string;
  /**
   * When `true`, skip all subscriptions and do nothing.
   * Use when the hook's dependencies are not yet resolved (e.g. auth pending).
   */
  skip?: boolean;
}

/**
 * Wire transport message updates into `useChat()`'s `setMessages` updater.
 *
 * Resolves both the transport view and the streaming gate from the nearest
 * `ChatTransportProvider`. Pass `channelName` to target a specific provider.
 * Pass `skip: true` to pause all subscriptions.
 * @param options - Hook options.
 * @param options.setMessages - The `setMessages` function from `useChat()`. Required.
 * @param options.channelName - Channel name of the provider to observe; defaults to nearest.
 * @param options.skip - When `true`, skip all subscriptions.
 */
export const useMessageSync = ({ setMessages, channelName, skip }: UseMessageSyncOptions): void => {
  const { transport, chatTransport, chatTransportError } = useChatTransport({ channelName, skip });

  // Only use resolved values when a provider was found and skip is false.
  const resolved = !skip && !chatTransportError;
  const view = resolved ? transport.view : undefined;
  const resolvedChatTransport = resolved ? chatTransport : undefined;

  const [gated, setGated] = useState(false);

  // Subscribe to the ChatTransport's streaming state to gate setMessages.
  // Reset gated to the new instance's current state so a stale `true`
  // from a previous instance doesn't permanently suppress syncs.
  useEffect(() => {
    if (!resolvedChatTransport) {
      setGated(false);
      return;
    }
    setGated(resolvedChatTransport.streaming);
    return resolvedChatTransport.onStreamingChange(setGated);
  }, [resolvedChatTransport]);

  // Subscribe to view updates and sync messages, unless gated.
  useEffect(() => {
    if (!view || gated) return;

    const sync = (): void => {
      setMessages(() => view.flattenNodes().map((n) => n.message));
    };

    // Sync immediately when the effect runs (covers gate-open and initial mount).
    sync();

    return view.on('update', sync);
  }, [view, setMessages, gated]);
};
