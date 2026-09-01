/**
 * useChatHydration — hydrate one conversation before the chat mounts.
 *
 * Reads the provider's transport pair (`useChatTransport`) and resolves in one
 * shot: connect the transport (idempotent — the provider connects too), fetch
 * the persisted conversation from `/api/messages`, then hand its serial to
 * `chatTransport.readSince()`, which walks the channel back only as far as
 * that serial and returns the messages published since. The store's messages
 * plus the walked ones are what `useChat` initializes from.
 *
 * `readSince` withholds any message whose run has not ended and retains its
 * events for `reconnectToStream`, so a run still streaming at page load is
 * delivered by useChat's `resume: true` path rather than appearing twice.
 *
 * The whole pass is cached per adapter instance: React Strict Mode re-runs the
 * effect against the same pair, and a second walk would advance the
 * transport's shared history cursor past the window, so both runs must share
 * one pass. A failed pass is evicted so a later mount can retry.
 */

import { useEffect, useState } from 'react';
import type { UIMessage } from 'ai';
import type { ClientTransport } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';
import type { ChatTransport } from '@ably/ai-transport/vercel/react';
import { useChatTransport } from '@ably/ai-transport/vercel/react';
import type { StoredConversation } from '../lib/message-store';

/** Options for {@link useChatHydration}. */
export interface UseChatHydrationOptions {
  /** The conversation's channel name (also the store's conversation id). */
  channelName: string;
}

/** What {@link useChatHydration} resolves once hydration completes. */
export interface ChatHydrationHandle {
  /** The provider's useChat adapter, its history walk already run. */
  chatTransport: ChatTransport;
  /** The hydrated conversation useChat initializes from: store seed + the channel walk. */
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
 * Connect, fetch the stored conversation, and walk the channel forward from
 * the serial it is complete up to.
 * @param transport - The provider's client transport.
 * @param chatTransport - The useChat adapter whose walk to run.
 * @param channelName - The store's conversation id.
 * @returns The initial messages and whether older history remains.
 */
async function hydrate(
  transport: ClientTransport<VercelInput, VercelOutput>,
  chatTransport: ChatTransport,
  channelName: string,
): Promise<HydrationResult> {
  // Connect (attach) and fetch the store in parallel: the attach point bounds
  // the walk, and the walk needs the store's serial, so both must land first.
  const [, storeResponse] = await Promise.all([
    transport.connect(),
    fetch(`/api/messages?conversationId=${encodeURIComponent(channelName)}`),
  ]);
  if (!storeResponse.ok) {
    throw new Error(`messages request failed with status ${String(storeResponse.status)}`);
  }
  const data: unknown = await storeResponse.json();
  // CAST: trust boundary — the /api/messages body is our own StoredConversation,
  // narrowed by the shape guard below.
  const stored = data as StoredConversation;
  const seed = Array.isArray(stored.messages) ? stored.messages : [];
  const walk = await chatTransport.readSince(stored.latestSerial);
  return { initialMessages: [...seed, ...walk.messages], hasOlder: !walk.exhausted };
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
