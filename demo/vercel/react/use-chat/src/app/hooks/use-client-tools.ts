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
 *
 * Each execution is reported via the optional `onExecute` callback — once with
 * status `executing` when the tool fires here (after the targeting gate), then
 * again with status `done` and the output once the executor resolves. This is
 * driven by the actual execution path, so it reflects which client truly ran
 * the tool (unlike useChat's `onToolCall`, which fires only on the sender that
 * consumes the response stream).
 */

import { useEffect, useRef } from 'react';
import { getToolName, isToolUIPart, type ChatAddToolOutputFunction, type UIMessage } from 'ai';
import type { ClientSession, CodecMessage, RunInfo } from '@ably/ai-transport';
import type { VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';
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
  session: ClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>,
  messages: CodecMessage<UIMessage>[],
  addToolResult: ChatAddToolOutputFunction<UIMessage>,
  runOf: (codecMessageId: string) => RunInfo | undefined,
  clientId: string | undefined,
  onExecute?: (entry: ClientToolLogEntry) => void,
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
        if (!isToolUIPart(part)) continue;
        // A statically-declared tool arrives as `tool-${name}` (name in the
        // type); a dynamic one as `dynamic-tool` with `toolName`. `getToolName`
        // reads the name from either representation.
        const toolName = getToolName(part);

        if (part.state !== 'input-available') continue;
        if (!clientTools[toolName]) continue;
        if (handledRef.current.has(part.toolCallId)) continue;

        handledRef.current.add(part.toolCallId);

        const startedAt = Date.now();
        onExecute?.({
          time: startedAt,
          toolName,
          toolCallId: part.toolCallId,
          input: part.input,
          status: 'executing',
        });

        // The tool output reaches the tree via the channel echo (the
        // continuation wire that addToolResult publishes is folded by
        // the codec's reducer). See AIT-776 for a synchronous adapter
        // path that would skip the echo round-trip.
        void clientTools[toolName](part.input).then((output) => {
          onExecute?.({
            time: startedAt,
            toolName,
            toolCallId: part.toolCallId,
            input: part.input,
            status: 'done',
            output,
          });
          addToolResult({
            tool: toolName,
            toolCallId: part.toolCallId,
            output,
          });
        });
      }
    }
  }, [session, messages, addToolResult, runOf, clientId, onExecute]);
}
