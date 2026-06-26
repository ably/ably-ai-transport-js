/**
 * useMessageSync: wire view updates into useChat's setMessages.
 *
 * During active own-run streams, setMessages is gated to avoid an
 * ID-mismatch in useChat's write(). When the stream ends, the gate
 * opens and the view is synced into useChat's overlay.
 *
 * The sync is a per-message merge, not a replace: when the overlay has
 * resolved a client-side tool locally (via addToolResult) but the
 * tree's echo hasn't landed yet, the overlay's resolution wins.
 * Without that, the gate-open sync would race the AI SDK's post-stream
 * sendAutomaticallyWhen check and could clobber the resolution before
 * the continuation publishes.
 */

import type * as AI from 'ai';
import { useEffect, useRef, useState } from 'react';

import { isToolPart, type ToolPart } from '../tool-part.js';
import { useChatTransport } from './use-chat-transport.js';

/** Options for {@link useMessageSync}. */
export interface UseMessageSyncOptions {
  /**
   * The `setMessages` updater function from `useChat()`. Called with an
   * updater that returns the next overlay.
   */
  setMessages: (updater: (prev: AI.UIMessage[]) => AI.UIMessage[]) => void;
  /**
   * The application's own seeded conversation — typically `useChat()`'s
   * `messages`, where persisted history was supplied via
   * `useChat({ messages })`. When non-empty, the hook reconciles it with the
   * live channel: it takes the newest entry's `id` as the **seam** (keyed on
   * the domain `message.id`, the only id shared between the application's store
   * and the channel — the transport's internal `codecMessageId` is never
   * persisted), pages the view back until that id reappears, and composes
   * `seed ⧺ live` with no duplicate at the seam.
   *
   * Read **once per channel**, on the first render the view resolves — so pass
   * your loaded seed by then (as `useChat({ messages })` does synchronously).
   * Omit it, or pass an empty array, for the unchanged behaviour of surfacing
   * the full live channel history.
   *
   * Reconciliation assumes this hook's backward walk is the only thing paging
   * the underlying view: it drops the single overlapping message where the
   * walk stops at the seam. Pointing another paginator (e.g. {@link useView})
   * at the same session view and paging it past the seam can reintroduce a
   * duplicate; render the seeded conversation from the composed messages
   * instead.
   */
  messages?: AI.UIMessage[];
  /**
   * Channel name of the {@link ChatTransportProvider} to observe.
   * Omit to use the nearest provider.
   */
  channelName?: string;
  /** When `true`, skip all subscriptions. */
  skip?: boolean;
}

// ---------------------------------------------------------------------------
// Tool-resolution merge
// ---------------------------------------------------------------------------
//
// The merge matches tool parts by toolCallId (via the shared {@link isToolPart}
// guard, which accepts both the codec's `dynamic-tool` shape and the AI SDK's
// `tool-${name}` shape) and keeps the tree's `type` on the result so downstream
// consumers narrowing on `dynamic-tool` keep working.

const RESOLVED_TOOL_STATES = new Set(['output-available', 'output-error', 'approval-responded', 'output-denied']);

const mergeAssistant = (tree: AI.UIMessage, overlay: AI.UIMessage): AI.UIMessage => {
  const overlayByCallId = new Map<string, ToolPart>();
  for (const part of overlay.parts) {
    if (isToolPart(part)) overlayByCallId.set(part.toolCallId, part);
  }
  if (overlayByCallId.size === 0) return tree;

  const parts = tree.parts.map((part) => {
    if (!isToolPart(part)) return part;
    if (RESOLVED_TOOL_STATES.has(part.state)) return part;
    const overlayPart = overlayByCallId.get(part.toolCallId);
    if (!overlayPart || !RESOLVED_TOOL_STATES.has(overlayPart.state)) return part;
    // CAST: tool-${name} and dynamic-tool share the discriminated payload schema.
    return { ...overlayPart, type: part.type } as AI.UIMessage['parts'][number];
  });

  const changed = parts.some((p, i) => p !== tree.parts[i]);
  return changed ? { ...tree, parts } : tree;
};

const mergeMessages = (tree: AI.UIMessage[], overlay: AI.UIMessage[]): AI.UIMessage[] => {
  if (overlay.length === 0) return tree;
  const overlayById = new Map(overlay.map((m) => [m.id, m]));
  return tree.map((treeMsg) => {
    if (treeMsg.role !== 'assistant') return treeMsg;
    const overlayMsg = overlayById.get(treeMsg.id);
    return overlayMsg ? mergeAssistant(treeMsg, overlayMsg) : treeMsg;
  });
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** The seed captured for the current view: the persisted prefix and its seam id. */
interface CapturedSeed {
  /** The application's seeded messages — the persisted prefix to prepend. */
  prefix: AI.UIMessage[];
  /** The newest seed message's domain id — where the live channel rejoins the seed. */
  seamId: string;
}

/**
 * Subscribe to view updates and sync them into `useChat()`'s overlay.
 *
 * When a seed is supplied via `messages`, the live view is reconciled with it:
 * the persisted prefix is prepended and the single overlapping message at the
 * seam is dropped, so a reloaded conversation shows its stored history plus the
 * live tail exactly once. With no seed, the full live channel history is
 * surfaced unchanged.
 * @param options - Hook options.
 * @param options.setMessages - The `setMessages` function from `useChat()`.
 * @param options.messages - The application's seeded conversation to reconcile with the live channel; omit for full channel history.
 * @param options.channelName - Channel name of the provider to observe; defaults to the nearest.
 * @param options.skip - When `true`, skip all subscriptions.
 */
export const useMessageSync = ({ messages, setMessages, channelName, skip }: UseMessageSyncOptions): void => {
  const { session, chatTransport, chatTransportError } = useChatTransport({ channelName, skip });

  const resolved = !skip && !chatTransportError;
  const view = resolved ? session.view : undefined;
  const resolvedChatTransport = resolved ? chatTransport : undefined;

  const [gated, setGated] = useState(false);

  // Latest seed, read in effects without re-subscribing as the array grows
  // (useChat's `messages` grows over the session; the seam is captured once).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // The seed captured for the current view; `undefined` is no-seed mode.
  const seedRef = useRef<CapturedSeed | undefined>(undefined);

  // Subscribe to the ChatTransport's streaming state. Reset on transport
  // change so a stale `true` doesn't permanently suppress syncs.
  useEffect(() => {
    if (!resolvedChatTransport) {
      setGated(false);
      return;
    }
    setGated(resolvedChatTransport.streaming);
    return resolvedChatTransport.onStreamingChange(setGated);
  }, [resolvedChatTransport]);

  // Capture the seed once per view: the newest seed message's domain id is the
  // seam where the live channel rejoins the persisted prefix. Reset on view
  // change so a new channel re-captures (or drops into no-seed mode). When a
  // seed is captured, page the view back until the seam reappears so the live
  // window joins the seed with no gap; each reveal emits 'update', which the
  // sync effect recomposes.
  useEffect(() => {
    seedRef.current = undefined;
    if (!view) return;

    const seed = messagesRef.current;
    if (!seed || seed.length === 0) return;
    const seamId = seed.at(-1)?.id;
    if (seamId === undefined) return;

    seedRef.current = { prefix: seed, seamId };

    const controller = new AbortController();
    const { signal } = controller;
    const walkToSeam = async (): Promise<void> => {
      // The `signal.aborted` guard stops the walk after unmount / view change:
      // the in-flight `loadOlder` settles, then the loop exits before paging on.
      while (!signal.aborted && view.hasOlder()) {
        const revealed = await view.loadOlder(1);
        // An empty page means history is exhausted, the view is closed, or a
        // load is already in flight — stop rather than spin.
        if (revealed.length === 0) return;
        if (revealed.some((m) => m.message.id === seamId)) return;
      }
    };
    // Fire-and-forget: the walk drives itself off `loadOlder` and is stopped via
    // the abort signal on cleanup; awaiting it would block the effect.
    void walkToSeam();

    return () => {
      controller.abort();
    };
  }, [view]);

  // Subscribe to view updates and sync, unless gated.
  useEffect(() => {
    if (!view || gated) return;

    const sync = (): void => {
      // Read the view inside the updater so the freshest visible window is
      // composed when React applies the state, not when `sync` was scheduled.
      setMessages((overlay) => {
        const visible = view.getMessages();
        const seed = seedRef.current;
        if (!seed)
          return mergeMessages(
            visible.map((m) => m.message),
            overlay,
          );

        // Compose seed ⧺ live: drop the single seam overlap — the seam row sits
        // at the front of the visible window once the walk has revealed it (the
        // walk pages one message at a time and stops on the seam, so it is the
        // oldest, i.e. first, visible message).
        const live = visible[0]?.message.id === seed.seamId ? visible.slice(1) : visible;
        const composed = [...seed.prefix, ...live.map((m) => m.message)];
        return mergeMessages(composed, overlay);
      });
    };

    // Sync immediately to cover gate-open and initial mount.
    sync();

    return view.on('update', sync);
  }, [view, setMessages, gated]);
};
