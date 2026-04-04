/**
 * useClientTools — automatically executes client-side tools when they appear
 * in the conversation, using useChat's addToolResult.
 *
 * Skips tool calls that already have a follow-up assistant message — those
 * were resolved in a previous session and don't need re-execution.
 * Only executes for turns initiated by this client (matches x-ably-turn-client-id).
 */

import { useEffect, useRef } from 'react';
import type { ChatAddToolOutputFunction, DynamicToolUIPart, UIMessage } from 'ai';
import type { TreeNode } from '@ably/ai-transport';

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
  nodes: TreeNode<UIMessage>[],
  clientId: string | undefined,
) {
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;

      // Only execute client tools for turns initiated by this client.
      // Look up the transport node by message ID to check the turn owner.
      const node = nodes.find((n) => n.message.id === msg.id);
      const turnClientId = node?.headers['x-ably-turn-client-id'];
      if (turnClientId && turnClientId !== clientId) continue;

      // If there's a later assistant message, this tool call was already
      // resolved in a previous session — skip.
      const hasFollowUpAssistant = messages.slice(i + 1).some((m) => m.role === 'assistant');
      if (hasFollowUpAssistant) continue;

      for (const part of msg.parts) {
        if (part.type !== 'dynamic-tool') continue;
        const toolPart = part as DynamicToolUIPart;

        if (toolPart.state !== 'input-available') continue;
        if (!clientTools[toolPart.toolName]) continue;
        if (handledRef.current.has(toolPart.toolCallId)) continue;

        handledRef.current.add(toolPart.toolCallId);

        void clientTools[toolPart.toolName](toolPart.input).then((output) => {
          addToolResult({
            tool: toolPart.toolName,
            toolCallId: toolPart.toolCallId,
            output,
          });
        });
      }
    }
  }, [messages, addToolResult, nodes, clientId]);
}
