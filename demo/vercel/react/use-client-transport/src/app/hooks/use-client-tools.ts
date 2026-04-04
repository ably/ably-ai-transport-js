/**
 * useClientTools — automatically executes client-side tools when they appear
 * in the conversation.
 *
 * Watches the view's message list for tool parts in `input-available` state
 * that match a registered client tool. Executes the tool, publishes the result
 * via `view.update()`, which amends the assistant message and starts a
 * continuation turn so the model can use the result.
 *
 * Skips tool calls that already have a follow-up assistant message — those
 * were resolved in a previous session and don't need re-execution.
 */

import { useEffect, useRef } from 'react';
import type { DynamicToolUIPart, UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { TreeNode } from '@ably/ai-transport';

type ClientToolExecutor = (input: unknown) => Promise<unknown>;

const clientTools: Record<string, ClientToolExecutor> = {
  getLocation: async () => {
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

export function useClientTools(view: ViewHandle<UIMessageChunk, UIMessage>) {
  // Track which tool calls we've already handled to avoid re-executing
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    const nodes = view.nodes;
    if (nodes.length === 0) return;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const msg = node.message;
      if (msg.role !== 'assistant') continue;

      // If there's a later assistant message, this tool call was already
      // resolved in a previous session — skip to prevent re-execution
      // on page refresh.
      const hasFollowUpAssistant = nodes.slice(i + 1).some((n) => n.message.role === 'assistant');
      if (hasFollowUpAssistant) continue;

      for (const part of msg.parts) {
        if (part.type !== 'dynamic-tool') continue;
        const toolPart = part as DynamicToolUIPart;

        if (toolPart.state !== 'input-available') continue;
        if (!clientTools[toolPart.toolName]) continue;
        if (handledRef.current.has(toolPart.toolCallId)) continue;

        handledRef.current.add(toolPart.toolCallId);

        executeClientTool(view, node, toolPart);
      }
    }
  }, [view, view.nodes]);
}

async function executeClientTool(
  view: ViewHandle<UIMessageChunk, UIMessage>,
  node: TreeNode<UIMessage>,
  toolPart: DynamicToolUIPart,
): Promise<void> {
  const executor = clientTools[toolPart.toolName];
  if (!executor) return;

  try {
    const output = await executor(toolPart.input);

    // Amend the assistant message with the tool result and start a
    // continuation turn so the model can use it.
    await view.update(node.msgId, [
      {
        type: 'tool-output-available',
        toolCallId: toolPart.toolCallId,
        output,
      } as UIMessageChunk,
    ]);
  } catch {
    await view.update(node.msgId, [
      {
        type: 'tool-output-error',
        toolCallId: toolPart.toolCallId,
        errorText: 'Client tool execution failed',
      } as UIMessageChunk,
    ]);
  }
}
