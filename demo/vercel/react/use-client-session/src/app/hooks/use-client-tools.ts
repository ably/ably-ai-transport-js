/**
 * useClientTools - automatically executes client-side tools when they appear
 * in the conversation.
 *
 * Watches the view's message list for tool parts in `input-available` state
 * that match a registered client tool. Executes the tool, then publishes a
 * `tool-output-available` UIMessageChunk on the channel via `view.sendEvent`.
 * The codec's reducer folds the chunk onto the assistant message that
 * issued the tool call (matched by `toolCallId`) and marks the wire
 * continuation message as consumed.
 *
 * Skips tool calls that already have a follow-up assistant message - those
 * were resolved in a previous session and don't need re-execution.
 * Only executes for runs initiated by this client (matches owningRun.clientId).
 */

import { useEffect, useRef } from 'react';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { VercelEvent, VercelProjection } from '@ably/ai-transport/vercel';

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
        { enableHighAccuracy: highAccuracy, timeout: 30000 },
      );
    });
  },
};

export function useClientTools(
  view: ViewHandle<VercelEvent, VercelProjection, UIMessage>,
  clientId: string | undefined,
) {
  // Track which tool calls we've already handled to avoid re-executing
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    const messages = view.messages;
    if (messages.length === 0) return;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;

      // Only execute client tools for runs initiated by this client.
      // Other clients on the same channel see the tool call but should
      // not execute it - only the requesting client has the context
      // (e.g. browser geolocation) to provide the result.
      const owningRun = view.getRunByCodecMessageId(msg.id);
      if (!owningRun) continue;
      if (owningRun.clientId && owningRun.clientId !== clientId) continue;

      // If there's a later assistant message, this tool call was already
      // resolved in a previous session - skip to prevent re-execution
      // on page refresh.
      const hasFollowUpAssistant = messages.slice(i + 1).some((m) => m.role === 'assistant');
      if (hasFollowUpAssistant) continue;

      for (const part of msg.parts) {
        if (part.type !== 'dynamic-tool') continue;
        const toolPart = part as DynamicToolUIPart;

        if (toolPart.state !== 'input-available') continue;
        if (!clientTools[toolPart.toolName]) continue;
        if (handledRef.current.has(toolPart.toolCallId)) continue;

        handledRef.current.add(toolPart.toolCallId);

        executeClientTool(view, owningRun.runId, toolPart);
      }
    }
  }, [view, view.messages, clientId]);
}

// The tool output amends the suspended assistant message; the continuation
// reuses that run's runId so the agent's lookupToolOutputs picks the output
// up off the channel and resumes generation.
async function executeClientTool(
  view: ViewHandle<VercelEvent, VercelProjection, UIMessage>,
  runId: string,
  toolPart: DynamicToolUIPart,
): Promise<void> {
  const executor = clientTools[toolPart.toolName];
  if (!executor) return;

  try {
    const output = await executor(toolPart.input);
    await view.sendEvent(
      [
        {
          type: 'tool-output-available',
          toolCallId: toolPart.toolCallId,
          output,
        },
      ],
      { runId },
    );
  } catch (error) {
    await view.sendEvent(
      [
        {
          type: 'tool-output-error',
          toolCallId: toolPart.toolCallId,
          errorText: error instanceof Error ? error.message : 'Client tool execution failed',
        },
      ],
      { runId },
    );
  }
}
