/**
 * useMessageSync: wires transport message lifecycle events into useChat's setMessages.
 *
 * Subscribes to the transport view's 'update' event and replaces messages state
 * with the view's authoritative message list.
 *
 * When a ChatTransport is provided (or resolved from the nearest ChatTransportProvider),
 * setMessages calls are gated during active own-turn streams. This prevents the
 * push/replace ID mismatch in useChat's write() function. When the stream finishes,
 * the gate opens and an immediate sync fires to pick up any observer messages that
 * arrived during the stream.
 *
 * All options except setMessages are resolved from the nearest ChatTransportProvider
 * via useChatTransport() when not explicitly provided.
 *
 * Returns the unsubscribe function in the useEffect cleanup so handlers
 * are removed on unmount or when dependencies change.
 */

import type * as AI from 'ai';
import { useEffect, useState } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';
import type { ChatTransport } from '../transport/chat-transport.js';
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
   * The client transport to observe for message updates.
   * Defaults to the transport from the nearest {@link ChatTransportProvider} via {@link useChatTransport}.
   */
  transport?: ClientTransport<unknown, AI.UIMessage> | null;
  /**
   * The chat transport used to gate `setMessages` during active own-turn streams.
   * Defaults to the chatTransport from the nearest {@link ChatTransportProvider} via {@link useChatTransport}.
   */
  chatTransport?: ChatTransport | null;
  /**
   * When `true`, skip all subscriptions and do nothing.
   * Use when the hook's dependencies are not yet resolved (e.g. auth pending).
   */
  skip?: boolean;
}

/**
 * Wire transport message updates into `useChat()`'s `setMessages` updater.
 *
 * Subscribes to the nearest `ChatTransportProvider`'s transport view by default.
 * Override any dependency by passing it explicitly.
 * Pass `skip: true` to pause all subscriptions.
 * @param options - Hook options.
 * @param options.setMessages - The `setMessages` function from `useChat()`. Required.
 * @param options.transport - Transport to observe; defaults to nearest `ChatTransportProvider`.
 * @param options.chatTransport - ChatTransport for streaming gate; defaults to nearest `ChatTransportProvider`.
 * @param options.skip - When `true`, skip all subscriptions.
 */
export const useMessageSync = ({
  setMessages,
  transport: transportProp,
  chatTransport: chatTransportProp,
  skip,
}: UseMessageSyncOptions): void => {
  // Always read from context for defaults. When no ChatTransportProvider is present,
  // chatTransportError is set and context values are stubs — we don't use them.
  const chatTransportHandle = useChatTransport({ skip });
  const {
    chatTransport: contextChatTranport,
    transport: contextTransport,
  } = chatTransportHandle.chatTransportError ? {} : chatTransportHandle;


  // Explicit props take precedence
  // When skip is true, always resolve to undefined so both effects are no-ops.
  const transport = skip
    ? undefined
    : transportProp ?? contextTransport;

  const chatTransport = skip
    ? undefined
    : chatTransportProp ?? contextChatTranport;

  const view = skip ? undefined : transport?.view;

  const [gated, setGated] = useState(false);

  // Subscribe to the ChatTransport's streaming state to gate setMessages.
  // Reset gated to the new instance's current state so a stale `true`
  // from a previous instance doesn't permanently suppress syncs.
  useEffect(() => {
    if (!chatTransport) {
      setGated(false);
      return;
    }
    setGated(chatTransport.streaming);
    return chatTransport.onStreamingChange(setGated);
  }, [chatTransport]);

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
