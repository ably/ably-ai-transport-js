/**
 * useClientTools - automatically executes client-side tools when they appear
 * in the conversation.
 *
 * Watches the view's message list for tool parts in `input-available` state
 * that match a registered client tool. Executes the tool, then publishes a
 * `tool-result` (or `tool-result-error`) TInput on the channel via
 * `view.send`. The codec's reducer folds the result onto the
 * assistant message addressed by `codecMessageId` (matched by `toolCallId`
 * within that message).
 *
 * Skips tool calls that already have a follow-up assistant message - those
 * were resolved in a previous session and don't need re-execution.
 * Only executes for runs initiated by this client (matches owningRun.clientId).
 */

import { useEffect, useRef } from 'react';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import { UIMessageCodec, type VercelInput } from '@ably/ai-transport/vercel';

import { wakeAgent } from '../helpers';

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

export function useClientTools(view: ViewHandle<VercelInput, UIMessage>, clientId: string | undefined, api: string) {
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
      const run = view.runOf(msg.id);
      if (!run) continue;
      if (run.clientId && run.clientId !== clientId) continue;

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

        executeClientTool(view, api, run.runId, msg.id, toolPart);
      }
    }
  }, [view, view.messages, clientId, api]);
}

// The tool result targets the suspended assistant message via
// `codecMessageId`; the continuation reuses that run's runId so the
// agent picks the result up off the channel and resumes generation.
async function executeClientTool(
  view: ViewHandle<VercelInput, UIMessage>,
  api: string,
  runId: string,
  codecMessageId: string,
  toolPart: DynamicToolUIPart,
): Promise<void> {
  const executor = clientTools[toolPart.toolName];
  if (!executor) return;

  // Compute the resolution input first so executor failure produces a
  // tool-result-error without entangling the publish/wake error handling.
  let input: VercelInput;
  try {
    const output = await executor(toolPart.input);
    input = UIMessageCodec.createToolResult(codecMessageId, { toolCallId: toolPart.toolCallId, output });
  } catch (error) {
    input = UIMessageCodec.createToolResultError(codecMessageId, {
      toolCallId: toolPart.toolCallId,
      message: error instanceof Error ? error.message : 'Client tool execution failed',
    });
  }

  // Publish the resolution, then wake the agent so it picks it up and resumes.
  const run = await view.send([input], { runId });
  await wakeAgent(api, run);
}
