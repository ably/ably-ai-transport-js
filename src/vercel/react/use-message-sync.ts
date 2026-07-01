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
import { useEffect, useState } from 'react';

import { isToolPart, type ToolPart } from '../tool-part.js';
import { useChatTransport } from './use-chat-transport.js';
import { useMessagesWithSeed } from './use-messages-with-seed.js';

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
// guard, which accepts both the `dynamic-tool` and `tool-${name}` shapes) and
// keeps the tree's `type` on the result, so the merged part stays in whichever
// representation the codec reconstructed.

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
    // Keep the tree part's `type` (its faithful representation) and adopt the
    // overlay's resolved payload. The codec preserves each side's
    // representation, so tree and overlay agree on `dynamic-tool` vs
    // `tool-${name}` for a given tool — the retained `type` matches the
    // overlay's own `toolName`/no-`toolName` shape.
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

/**
 * Sync the reconciled conversation into `useChat()`'s overlay.
 *
 * The seam reconciliation itself — paging the live view back to the seed's seam
 * and composing `seed ⧺ live` — is delegated to {@link useMessagesWithSeed}, so
 * the resilient backward walk has a single implementation shared with the
 * generic React layer. This hook adds the `useChat`-specific concerns on top:
 * the streaming gate and the tool-resolution merge.
 *
 * When a seed is supplied via `messages`, a reloaded conversation shows its
 * stored history plus the live tail exactly once. With no seed, the full live
 * channel history is surfaced unchanged.
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

  // Delegate seam reconciliation (backward walk + `seed ⧺ live` compose) to the
  // shared hook; `reconciled` advances as the view pages back and live messages
  // arrive.
  const reconciled = useMessagesWithSeed({ view, seed: messages ?? [] });

  const [gated, setGated] = useState(false);

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

  // Push the reconciled conversation into useChat's overlay, unless gated during
  // an own-run stream (which would clash with useChat's own write). Merge rather
  // than replace so a locally-resolved tool (via addToolResult) isn't clobbered
  // before the tree's echo lands. Re-runs as `reconciled` advances and when the
  // gate opens. The `view` guard/dep gives the gate-open re-sync a live view
  // even when `reconciled` is reference-stable (an unchanged window).
  useEffect(() => {
    if (!view || gated) return;
    setMessages((overlay) => mergeMessages(reconciled, overlay));
  }, [view, reconciled, gated, setMessages]);
};
