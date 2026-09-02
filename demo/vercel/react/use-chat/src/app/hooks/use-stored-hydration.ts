/**
 * useStoredHydration — build the conversation `useChat` starts from, before it
 * mounts.
 *
 * One read: `GET /api/messages`, the server's conversation store. No channel
 * history is paged. The store is written by the agent route as each run opens
 * and again when its stream ends, so it holds the whole conversation and the
 * demo needs no second source for it.
 *
 * The store also names the run streaming on the channel right now, if there is
 * one. A page that loads mid-run has the conversation but no live stream, so
 * it hands that run id to `resumeStream` as a `ReconnectHint` and the adapter
 * joins the run off the channel — the decoder's first contact with a stream in
 * progress carries the text so far, so nothing published before the page
 * loaded is lost.
 *
 * The read is cached per adapter instance: React Strict Mode re-runs the
 * effect against the same pair and both runs must share one pass. A failed
 * pass is evicted so a later mount can retry.
 */

import { useEffect, useState } from 'react';
import type { UIMessage } from 'ai';
import type { ChatTransport } from '@ably/ai-transport/vercel';
import { useChatTransport } from '@ably/ai-transport/vercel/react';

import type { StoredConversation } from '../lib/message-store';

/** Options for {@link useStoredHydration}. */
export interface UseStoredHydrationOptions {
  /** The conversation's channel name, which is also the store's key. */
  channelName: string;
}

/** What {@link useStoredHydration} resolves once the store has been read. */
export interface StoredHydrationHandle {
  /** The provider's useChat adapter. */
  chatTransport: ChatTransport;
  /** The conversation useChat initializes from. */
  initialMessages: UIMessage[];
  /** The run streaming on the channel, for the client to resume. Undefined when none is open. */
  activeRunId: string | undefined;
}

/** The hook's state: reading, ready, or failed. */
export type StoredHydrationState =
  | { status: 'loading' }
  | ({ status: 'ready' } & StoredHydrationHandle)
  | { status: 'error'; error: Error };

interface HydrationResult {
  initialMessages: UIMessage[];
  activeRunId: string | undefined;
}

/** One shared read per adapter instance (see the module comment). */
const hydrations = new WeakMap<ChatTransport, Promise<HydrationResult>>();

/**
 * Read the stored conversation for the enclosing provider's channel.
 * @param options - The conversation's channel name; see {@link UseStoredHydrationOptions}.
 * @returns The hydration state.
 */
export function useStoredHydration({ channelName }: UseStoredHydrationOptions): StoredHydrationState {
  const { chatTransport, error } = useChatTransport();
  const [state, setState] = useState<StoredHydrationState>({ status: 'loading' });

  useEffect(() => {
    // A provider that failed to build an adapter is reported below, from the
    // render pass rather than from here.
    if (!chatTransport) return;
    let cancelled = false;
    let pass = hydrations.get(chatTransport);
    if (!pass) {
      pass = (async () => {
        const response = await fetch(`/api/messages?channelName=${encodeURIComponent(channelName)}`);
        if (!response.ok) {
          throw new Error(`messages request failed with status ${String(response.status)}`);
        }
        // CAST: trust boundary — the response body is our own messages route's
        // JSON, which serves the store verbatim.
        const stored = (await response.json()) as StoredConversation;
        return {
          initialMessages: Array.isArray(stored.messages) ? stored.messages : [],
          activeRunId: stored.activeRunId,
        };
      })();
      hydrations.set(chatTransport, pass);
      // Evict a failed pass so a later mount retries; the consumer below
      // observes the same rejection through its own catch.
      pass.catch(() => hydrations.delete(chatTransport));
    }
    // No reset to `loading` here: the state starts there, and the provider
    // builds one adapter per channel while a page renders one channel, so this
    // effect never re-runs against a resolved state.
    pass
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', chatTransport, ...result });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', error: cause instanceof Error ? cause : new Error(String(cause)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chatTransport, channelName]);

  if (!chatTransport) {
    return { status: 'error', error: new Error(error?.message ?? 'chat transport construction failed') };
  }
  return state;
}
