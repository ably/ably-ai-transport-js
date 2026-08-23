/**
 * useChatHydration — hydrate one conversation before the chat mounts.
 *
 * Reads the provider's transport pair (`useChatTransport`) and resolves in one
 * shot: connect the transport (idempotent — the provider connects too), fetch
 * the persisted seed from `/api/messages`, page the channel-history gap back
 * to the newest stored message, fold seed + gap into the messages `useChat`
 * initializes from, and seed the adapter's wire indices with the gap events
 * (`chatTransport.seed`, called exactly once).
 *
 * The whole pass is cached per adapter instance: React Strict Mode re-runs the
 * effect against the same pair, and a second walk would advance the
 * transport's shared history cursor past the gap, so both runs must share one
 * pass. A failed pass is evicted so a later mount can retry.
 */

import { useEffect, useState } from 'react';
import type { UIMessage } from 'ai';
import type { ClientTransport } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';
import type { ChatTransport } from '@ably/ai-transport/vercel/react';
import { useChatTransport } from '@ably/ai-transport/vercel/react';
import { collectGapEvents, mergeConversation } from '../lib/hydrate';

/** Options for {@link useChatHydration}. */
export interface UseChatHydrationOptions {
  /** The conversation's channel name (also the store's conversation id). */
  channelName: string;
}

/** What {@link useChatHydration} resolves once hydration completes. */
export interface ChatHydrationHandle {
  /** The provider's useChat adapter, seeded with the gap events. */
  chatTransport: ChatTransport;
  /** The hydrated conversation useChat initializes from: store seed + history gap. */
  initialMessages: UIMessage[];
  /** Whether channel history older than the hydrated window remains unpaged. */
  hasOlder: boolean;
}

/** The hook's state: connecting/hydrating, ready, or failed. */
export type ChatHydrationState =
  | { status: 'loading' }
  | ({ status: 'ready' } & ChatHydrationHandle)
  | { status: 'error'; error: Error };

interface HydrationResult {
  initialMessages: UIMessage[];
  hasOlder: boolean;
}

/** One shared hydration pass per adapter instance (see the module comment). */
const hydrations = new WeakMap<ChatTransport, Promise<HydrationResult>>();

/**
 * Connect, fetch the seed, page the gap, fold, and seed the adapter.
 * @param transport - The provider's client transport.
 * @param chatTransport - The useChat adapter to seed.
 * @param channelName - The store's conversation id.
 * @returns The initial messages and whether older history remains.
 */
async function hydrate(
  transport: ClientTransport<VercelInput, VercelOutput>,
  chatTransport: ChatTransport,
  channelName: string,
): Promise<HydrationResult> {
  // Connect (attach) and fetch the store seed in parallel: the attach point
  // bounds the history gap, and the gap walk needs the seed's newest id, so
  // both must land before paging starts.
  const [, seedResponse] = await Promise.all([
    transport.connect(),
    fetch(`/api/messages?conversationId=${encodeURIComponent(channelName)}`),
  ]);
  if (!seedResponse.ok) {
    throw new Error(`messages request failed with status ${String(seedResponse.status)}`);
  }
  const data: unknown = await seedResponse.json();
  // CAST: trust boundary — the /api/messages body is our own persisted
  // UIMessage[], narrowed by the Array.isArray guard.
  const seed = Array.isArray(data) ? (data as UIMessage[]) : [];
  const gap = await collectGapEvents(transport, seed.at(-1)?.id);
  const initialMessages = await mergeConversation(seed, gap.events);
  chatTransport.seed(gap.events);
  return { initialMessages, hasOlder: !gap.exhausted };
}

/**
 * Hydrate the conversation for the enclosing provider's channel.
 * @param options - The conversation's channel name.
 * @returns The hydration state.
 */
export function useChatHydration({ channelName }: UseChatHydrationOptions): ChatHydrationState {
  const { transport, chatTransport, error } = useChatTransport();
  const [state, setState] = useState<ChatHydrationState>({ status: 'loading' });

  useEffect(() => {
    if (!transport || !chatTransport) {
      setState({
        status: 'error',
        error: new Error(error?.message ?? 'chat transport construction failed'),
      });
      return;
    }
    let cancelled = false;
    let pass = hydrations.get(chatTransport);
    if (!pass) {
      pass = hydrate(transport, chatTransport, channelName);
      hydrations.set(chatTransport, pass);
      // Evict a failed pass so a later mount retries; the consumer below
      // observes the same rejection through its own catch.
      pass.catch(() => hydrations.delete(chatTransport));
    }
    setState({ status: 'loading' });
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
  }, [transport, chatTransport, error, channelName]);

  return state;
}
