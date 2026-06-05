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

import { useChatTransport } from './use-chat-transport.js';

/** Options for {@link useMessageSync}. */
export interface UseMessageSyncOptions {
  /**
   * The `setMessages` updater function from `useChat()`. Called with an
   * updater that returns the next overlay.
   */
  setMessages: (updater: (prev: AI.UIMessage[]) => AI.UIMessage[]) => void;
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
// The Vercel codec normalises every tool part to `dynamic-tool`, but the
// AI SDK emits `tool-${name}` for statically-declared tools. Both shapes
// share `toolCallId` + `state`; the merge matches by toolCallId and keeps
// the tree's `type` on the result so downstream consumers narrowing on
// `dynamic-tool` keep working.

type ToolPart = AI.DynamicToolUIPart | AI.ToolUIPart;

const RESOLVED_TOOL_STATES = new Set(['output-available', 'output-error', 'approval-responded', 'output-denied']);

const isToolPart = (part: AI.UIMessage['parts'][number]): part is ToolPart =>
  (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) && 'toolCallId' in part && 'state' in part;

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

/**
 * Subscribe to view updates and sync them into `useChat()`'s overlay.
 * @param options - Hook options.
 * @param options.setMessages - The `setMessages` function from `useChat()`.
 * @param options.channelName - Channel name of the provider to observe; defaults to the nearest.
 * @param options.skip - When `true`, skip all subscriptions.
 */
export const useMessageSync = ({ setMessages, channelName, skip }: UseMessageSyncOptions): void => {
  const { session, chatTransport, chatTransportError } = useChatTransport({ channelName, skip });

  const resolved = !skip && !chatTransportError;
  const view = resolved ? session.view : undefined;
  const resolvedChatTransport = resolved ? chatTransport : undefined;

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

  // Subscribe to view updates and sync, unless gated.
  useEffect(() => {
    if (!view || gated) return;

    const sync = (): void => {
      setMessages((overlay) =>
        mergeMessages(
          view.messages.map((p) => p.message),
          overlay,
        ),
      );
    };

    // Sync immediately to cover gate-open and initial mount.
    sync();

    return view.on('update', sync);
  }, [view, setMessages, gated]);
};
