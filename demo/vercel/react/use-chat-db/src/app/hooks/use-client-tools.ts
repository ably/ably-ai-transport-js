/**
 * useClientTools - automatically executes client-side tools when they appear
 * in the conversation, using useChat's addToolResult.
 *
 * Skips tool calls that already have a follow-up assistant message - those were
 * resolved in a previous session (rebuilt from the store seed or the channel)
 * and don't need re-execution. This demo renders a linear `useChat` message
 * list with no per-message Run attribution, so it can't tell which client
 * initiated a run; it relies on the follow-up-assistant guard to avoid
 * re-running an already-resolved tool call on hydrate.
 *
 * `addToolResult` is the sole continuation trigger; the tool output reaches the
 * conversation asynchronously via the channel echo and the codec's reducer.
 *
 * Each execution is reported via the optional `onExecute` callback — once with
 * status `executing` when the tool fires here (after the follow-up gate), then
 * again with status `done` and the output once the executor resolves. This is
 * driven by the actual execution path, so it reflects that this client ran the
 * tool (unlike useChat's `onToolCall`, which fires only on the sender that
 * consumes the response stream).
 */

import { useEffect, useRef } from 'react';
import type { ChatAddToolOutputFunction, DynamicToolUIPart, UIMessage } from 'ai';
import type { ClientToolLogEntry } from '../components/debug-pane';

type ClientToolExecutor = (input: unknown) => Promise<unknown>;

const clientTools: Record<string, ClientToolExecutor> = {
  getLocation: async (input) => {
    const { highAccuracy } = (input ?? {}) as { highAccuracy?: boolean };
    return new Promise<unknown>((resolve) => {
      if (!navigator.geolocation) {
        resolve({ error: 'Geolocation is not supported by this browser' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        (error) => {
          resolve({ error: error.message });
        },
        { enableHighAccuracy: highAccuracy, timeout: 10000 },
      );
    });
  },
};

export function useClientTools(
  messages: UIMessage[],
  addToolResult: ChatAddToolOutputFunction<UIMessage>,
  onExecute?: (entry: ClientToolLogEntry) => void,
) {
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;

      // If there's a later assistant message, this tool call was already
      // resolved in a previous session - skip.
      const hasFollowUpAssistant = messages.slice(i + 1).some((m) => m.role === 'assistant');
      if (hasFollowUpAssistant) continue;

      for (const part of msg.parts) {
        if (part.type !== 'dynamic-tool') continue;
        const toolPart = part as DynamicToolUIPart;

        if (toolPart.state !== 'input-available') continue;
        if (!clientTools[toolPart.toolName]) continue;
        if (handledRef.current.has(toolPart.toolCallId)) continue;

        handledRef.current.add(toolPart.toolCallId);

        const startedAt = Date.now();
        onExecute?.({
          time: startedAt,
          toolName: toolPart.toolName,
          toolCallId: toolPart.toolCallId,
          input: toolPart.input,
          status: 'executing',
        });

        // The tool output reaches the conversation via the channel echo (the
        // continuation wire that addToolResult publishes is folded by the
        // codec's reducer).
        void clientTools[toolPart.toolName](toolPart.input).then((output) => {
          onExecute?.({
            time: startedAt,
            toolName: toolPart.toolName,
            toolCallId: toolPart.toolCallId,
            input: toolPart.input,
            status: 'done',
            output,
          });
          addToolResult({
            tool: toolPart.toolName,
            toolCallId: toolPart.toolCallId,
            output,
          });
        });
      }
    }
  }, [messages, addToolResult, onExecute]);
}
