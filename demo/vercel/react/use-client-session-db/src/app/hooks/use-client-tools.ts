/**
 * useClientTools - automatically executes client-side tools when they appear
 * in the conversation.
 *
 * Watches the client view's messages for tool parts in `input-available` state
 * that match a registered client tool. Executes the tool, then publishes a
 * `tool-result` (or `tool-result-error`) TInput on the channel via
 * `view.send`. The codec's reducer folds the result onto the assistant message
 * addressed by `codecMessageId` (matched by `toolCallId` within that message).
 * That result resumes the suspended run, which the agent later persists to the
 * database as one whole suspend/resume turn.
 *
 * It reads `view.getMessages()` (the SDK's `CodecMessage[]`, each carrying its
 * `codecMessageId`) directly, so it works independently of the linear
 * `UIMessage[]` list the seam-walk renders.
 *
 * Skips tool calls that already have a follow-up assistant message - those
 * were resolved in a previous session and don't need re-execution.
 * Only executes for runs initiated by this client (matches owningRun.clientId).
 *
 * Each execution is reported via the optional `onExecute` callback — once with
 * status `executing` when the tool fires here (after the targeting gate), then
 * again with status `done` (and output) or `error` once the executor settles.
 * This is driven by the actual execution path, so it reflects which client
 * truly ran the tool — something a multi-client channel cannot otherwise show.
 */

import { useEffect, useRef } from 'react';
import { getToolName, isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai';
import type { ClientView } from '@ably/ai-transport';
import type { CodecMessage, TreeHandle } from '@ably/ai-transport/react';
import {
  createToolResultFork,
  createUIMessageSessionCodec,
  type ToolCallResolution,
  type VercelProjection,
  type VercelSessionInput,
} from '@ably/ai-transport/vercel';

import { wakeAgent, type ClientToolLogEntry } from '@ably-ai-demos/frontend';

const uiMessageCodec = createUIMessageSessionCodec();

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
  view: ClientView<VercelSessionInput, UIMessage>,
  getRunNode: TreeHandle<VercelProjection>['getRunNode'],
  clientId: string | undefined,
  api: string,
  onExecute?: (entry: ClientToolLogEntry) => void,
) {
  // Track which tool calls we've already handled to avoid re-executing
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    const sync = (): void => {
      // Correlate on the codec-message-id, never the domain `message.id`: the
      // run lookup and the tool result's target both key on the SDK's
      // client-minted id, which the domain id may not equal.
      const messages = view.getMessages();
      if (messages.length === 0) return;

      for (let i = 0; i < messages.length; i++) {
        const { codecMessageId, message: msg } = messages[i];
        if (msg.role !== 'assistant') continue;

        // Only execute client tools for runs initiated by this client.
        // Other clients on the same channel see the tool call but should
        // not execute it - only the requesting client has the context
        // (e.g. browser geolocation) to provide the result.
        const run = view.runOf(codecMessageId);
        if (!run) continue;
        if (run.clientId && run.clientId !== clientId) continue;

        // If there's a later assistant message, this tool call was already
        // resolved in a previous session - skip to prevent re-execution
        // on page refresh.
        const hasFollowUpAssistant = messages.slice(i + 1).some((m) => m.message.role === 'assistant');
        if (hasFollowUpAssistant) continue;

        // Resolve the fork's parent AND the suspended run's full message list
        // AUTHORITATIVELY from the run node — not a positional guess. The parent
        // is the run's input node; the run messages seed the fork so it carries
        // full history (context across SEQUENTIAL client tool calls).
        const node = getRunNode(run.runId);
        const parentCodecMessageId = node?.parentCodecMessageId;
        // Defensive: without a resolvable parent we cannot fork — skip.
        if (!node || parentCodecMessageId === undefined) continue;
        const runMessages = uiMessageCodec.getMessages(node.projection);

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

          executeClientTool(view, api, runMessages, parentCodecMessageId, run.runId, part, { onExecute, startedAt });
        }
      }
    };

    // Run once for the current state, then on every view update (streamed
    // tool-call chunks arrive via 'update', run-state via 'run').
    sync();
    const offUpdate = view.on('update', sync);
    const offRun = view.on('run', sync);
    return () => {
      offUpdate();
      offRun();
    };
  }, [view, getRunNode, clientId, api, onExecute]);
}

// The tool result FORKS the suspended tool call into its own reply run (via
// createToolResultFork): a fresh client-minted run parented at the suspended
// run's input node, carrying a self-contained copy of the suspended run's FULL
// message list. So when two clients (or two tabs sharing a clientId) answer the
// same tool call, their answers land on segregated sibling branches instead of
// colliding — and sequential tool calls keep their prior context.
async function executeClientTool(
  view: ClientView<VercelSessionInput, UIMessage>,
  api: string,
  runMessages: CodecMessage<UIMessage>[],
  parentCodecMessageId: string,
  supersedesRunId: string,
  toolPart: ToolUIPart | DynamicToolUIPart,
  log?: {
    onExecute?: (entry: ClientToolLogEntry) => void;
    startedAt: number;
  },
): Promise<void> {
  const toolName = getToolName(toolPart);
  const executor = clientTools[toolName];
  if (!executor) return;

  // Compute the resolution first so executor failure produces a
  // tool-result-error without entangling the publish/wake error handling.
  let result: ToolCallResolution;
  try {
    const output = await executor(toolPart.input);
    result = { output };
    if (log?.onExecute) {
      log.onExecute({
        time: log.startedAt,
        toolName,
        toolCallId: toolPart.toolCallId,
        input: toolPart.input,
        status: 'done',
        output,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Client tool execution failed';
    result = { errorMessage: message };
    if (log?.onExecute) {
      log.onExecute({
        time: log.startedAt,
        toolName,
        toolCallId: toolPart.toolCallId,
        input: toolPart.input,
        status: 'error',
        error: message,
      });
    }
  }

  // Fork the tool call into its own reply run, then wake the agent so it picks
  // up the result off the channel and resumes generation on the fork branch.
  const { input, sendOptions } = createToolResultFork({
    runMessages,
    parentCodecMessageId,
    toolCallId: toolPart.toolCallId,
    result,
    supersedesRunId,
  });
  const run = await view.send([input], sendOptions);
  await wakeAgent(api, run);
}
