/**
 * useClientTools - automatically executes client-side tools when they appear
 * in the conversation, using useChat's addToolResult.
 *
 * Skips tool calls that already have a follow-up assistant message - those
 * were resolved in a previous session and don't need re-execution.
 * Only executes for runs initiated by this client (matches owningRun.clientId).
 *
 * `addToolResult` is the sole continuation trigger; the tool output reaches
 * the tree asynchronously via the channel echo and the codec's reducer.
 * A synchronous optimistic fold path on the ChatTransport adapter is
 * tracked separately under AIT-776.
 */

import { useEffect, useRef } from 'react';
import type { ChatAddToolOutputFunction, DynamicToolUIPart, UIMessage } from 'ai';
import type { ClientSession, CodecMessage, RunInfo } from '@ably/ai-transport';
import type { VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';

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
  session: ClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>,
  messages: CodecMessage<UIMessage>[],
  addToolResult: ChatAddToolOutputFunction<UIMessage>,
  runOf: (codecMessageId: string) => RunInfo | undefined,
  clientId: string | undefined,
) {
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    for (let i = 0; i < messages.length; i++) {
      const { codecMessageId, message: msg } = messages[i];
      if (msg.role !== 'assistant') continue;

      // Only execute client tools for runs initiated by this client.
      // Other clients on the same channel see the tool call but should
      // not execute it - only the requesting client has the context
      // (e.g. browser geolocation) to provide the result. Correlate on the
      // codec-message-id, never the domain `message.id`.
      const run = runOf(codecMessageId);
      if (run?.clientId && run.clientId !== clientId) continue;

      // If there's a later assistant message, this tool call was already
      // resolved in a previous session - skip.
      const hasFollowUpAssistant = messages.slice(i + 1).some((m) => m.message.role === 'assistant');
      if (hasFollowUpAssistant) continue;

      for (const part of msg.parts) {
        if (part.type !== 'dynamic-tool') continue;
        const toolPart = part as DynamicToolUIPart;

        if (toolPart.state !== 'input-available') continue;
        if (!clientTools[toolPart.toolName]) continue;
        if (handledRef.current.has(toolPart.toolCallId)) continue;

        handledRef.current.add(toolPart.toolCallId);

        // The tool output reaches the tree via the channel echo (the
        // continuation wire that addToolResult publishes is folded by
        // the codec's reducer). See AIT-776 for a synchronous adapter
        // path that would skip the echo round-trip.
        void clientTools[toolPart.toolName](toolPart.input).then((output) => {
          addToolResult({
            tool: toolPart.toolName,
            toolCallId: toolPart.toolCallId,
            output,
          });
        });
      }
    }
  }, [session, messages, addToolResult, runOf, clientId]);
}
