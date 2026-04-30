/**
 * useClientTools — automatically executes client-side tools when they appear
 * in the conversation, using useChat's addToolResult.
 *
 * Skips tool calls that already have a follow-up assistant message — those
 * were resolved in a previous session and don't need re-execution.
 * Only executes for turns initiated by this client (matches x-ably-turn-client-id).
 *
 * On resolution, stages the tool-output event on the transport before
 * calling addToolResult. Staging applies the event to the conversation tree
 * immediately so any subsequent useMessageSync overwrite (e.g. from an
 * observer turn arriving on the channel) is idempotent — the tool result
 * won't be wiped from useChat state during the window before
 * sendAutomaticallyWhen fires.
 */

import { useEffect, useRef } from 'react';
import type { ChatAddToolOutputFunction, DynamicToolUIPart, UIMessage, UIMessageChunk } from 'ai';
import type { ClientTransport, MessageNode } from '@ably/ai-transport';

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
  transport: ClientTransport<UIMessageChunk, UIMessage>,
  messages: UIMessage[],
  addToolResult: ChatAddToolOutputFunction<UIMessage>,
  nodes: MessageNode<UIMessage>[],
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
        if (!node) continue;

        handledRef.current.add(toolPart.toolCallId);

        const treeMsgId = node.msgId;
        void clientTools[toolPart.toolName](toolPart.input).then((output) => {
          const chunk: UIMessageChunk = {
            type: 'tool-output-available',
            toolCallId: toolPart.toolCallId,
            output,
            dynamic: true,
            providerExecuted: false,
            preliminary: false,
          };
          transport.stageEvents(treeMsgId, [chunk]);
          addToolResult({
            tool: toolPart.toolName,
            toolCallId: toolPart.toolCallId,
            output,
          });
        });
      }
    }
  }, [transport, messages, addToolResult, nodes, clientId]);
}
