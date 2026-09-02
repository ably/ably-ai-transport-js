/**
 * useChannelHydration — build the conversation `useChat` starts from, before
 * it mounts.
 *
 * Two steps, in order. An application store is read first, if the demo has
 * one (`loadStored`), and then `chatTransport.readSince(latestSerial)` walks
 * the channel back as far as the serial the store is complete up to. A demo
 * with no store omits `loadStored` and the walk covers the whole channel.
 *
 * Running the walk is what makes `useChat({ resume: true })` work across a
 * reload. `readSince` withholds any message whose run has not ended and
 * retains its events for `reconnectToStream`; without the walk the adapter has
 * nothing retained and can only resume a run it watched start live, which a
 * page that just loaded never did.
 *
 * The pass is cached per adapter instance: React Strict Mode re-runs the
 * effect against the same pair, and a second walk would advance the
 * transport's shared history cursor past the window, so both runs must share
 * one pass. A failed pass is evicted so a later mount can retry.
 */

import { useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type { ChatTransport } from '@ably/ai-transport/vercel';
import { useChatTransport } from '@ably/ai-transport/vercel/react';

/** What an application store hands back for the walk to continue from. */
export interface StoredConversation {
  /** The stored messages, oldest-first. */
  messages: UIMessage[];
  /**
   * The channel serial the stored messages are complete up to. Omit when the
   * store holds nothing, or has no serial to report, and the walk covers the
   * whole channel.
   */
  latestSerial?: string;
}

/** Options for {@link useChannelHydration}. */
export interface UseChannelHydrationOptions {
  /**
   * Load the application's stored conversation. Called once per adapter, before
   * the walk. Omit it for a demo whose only source is the channel. Read through
   * a ref, so it need not be stable across renders.
   */
  loadStored?: () => Promise<StoredConversation>;
}

/** What {@link useChannelHydration} resolves once hydration completes. */
export interface ChannelHydrationHandle {
  /** The provider's useChat adapter, its history walk already run. */
  chatTransport: ChatTransport;
  /** The conversation useChat initializes from: the store, then the walk. */
  initialMessages: UIMessage[];
  /** Whether channel history older than the hydrated window remains unpaged. */
  hasOlder: boolean;
}

/** The hook's state: connecting/hydrating, ready, or failed. */
export type ChannelHydrationState =
  { status: 'loading' } | ({ status: 'ready' } & ChannelHydrationHandle) | { status: 'error'; error: Error };

interface HydrationResult {
  initialMessages: UIMessage[];
  hasOlder: boolean;
}

/** One shared hydration pass per adapter instance (see the module comment). */
const hydrations = new WeakMap<ChatTransport, Promise<HydrationResult>>();

/**
 * Hydrate the conversation for the enclosing provider's channel.
 * @param options - Optional application store to seed from; see {@link UseChannelHydrationOptions}.
 * @returns The hydration state.
 */
export function useChannelHydration(options: UseChannelHydrationOptions = {}): ChannelHydrationState {
  const { transport, chatTransport, error } = useChatTransport();
  const [state, setState] = useState<ChannelHydrationState>({ status: 'loading' });

  // The caller's loader is typically an inline arrow, so it changes identity
  // every render. Read it through a ref rather than making it an effect dep.
  const loadStoredRef = useRef(options.loadStored);
  loadStoredRef.current = options.loadStored;

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
      pass = (async () => {
        // Connect (attach) and read the store together: the attach point
        // bounds the walk and the walk needs the store's serial, so both must
        // land before paging starts.
        const [, stored] = await Promise.all([transport.connect(), loadStoredRef.current?.()]);
        const seed = stored?.messages ?? [];
        const walk = await chatTransport.readSince(stored?.latestSerial);
        // The walk can re-return a turn the store already holds — its
        // watermark is a lower bound, not an exact seam — so dedupe by domain
        // id with the store winning.
        const seedIds = new Set(seed.map((message) => message.id));
        const fresh = walk.messages.filter((message) => !seedIds.has(message.id));
        return { initialMessages: [...seed, ...fresh], hasOlder: !walk.exhausted };
      })();
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
  }, [transport, chatTransport, error]);

  return state;
}
