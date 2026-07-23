/**
 * useClientTools — runs client-executed tools when they appear unresolved in the
 * conversation and publishes their result so the suspended agent run resumes.
 *
 * Watches the view's messages for a `function_call` whose tool name is a client
 * tool (no server executor; see `isClientTool` in `../api/chat/tools`) that has
 * no `function_call_output` yet, on a run that has suspended. It waits for the
 * run to suspend so a resume never races the run's still-streaming output (a
 * server tool in the same turn whose result has not folded yet). It runs the
 * tool in the browser, then publishes
 * a `tool-result` (or `tool-result-error`) via `view.send` addressed to the
 * function_call's codec-message-id. The codec's reducer folds the output onto
 * that message (matched by `call_id`) and records the client-result status, and
 * the continuation reuses the run's runId so the agent picks the result up off
 * the channel and resumes.
 *
 * A `function_call_output` already present means the call was resolved (this
 * session or a prior one loaded from history), so the hook skips it and does not
 * re-execute on refresh. The `handledRef` dedup guards against a re-render
 * re-running an in-flight executor.
 */

import { useEffect, useRef } from 'react';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { OpenAIInput, OpenAIItem, OpenAIMessage } from '@ably/ai-transport/openai';
import { ResponsesCodec, resolvedCallIds } from '@ably/ai-transport/openai';

import { wakeAgent } from '../helpers';
import { isClientTool } from '../api/chat/tools';

/** A client tool executor: takes the call's parsed arguments and returns its output payload. */
type ClientToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

/** The browser-side executors, keyed by tool name. Only these tools run on the client. */
const clientTools: Record<string, ClientToolExecutor> = {
  getLocation: async (args) => {
    const highAccuracy = typeof args.highAccuracy === 'boolean' ? args.highAccuracy : false;
    return new Promise<unknown>((resolve) => {
      if (!navigator.geolocation) {
        resolve({ error: 'Geolocation is not supported by this browser' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
        (error) => resolve({ error: error.message }),
        { enableHighAccuracy: highAccuracy, timeout: 30000 },
      );
    });
  },
};

/** Parse a function_call's JSON arguments string into a plain object (empty on failure). */
function parseArgs(argumentsJson: string): Record<string, unknown> {
  try {
    // CAST: trust boundary — the model's arguments string is parsed JSON.
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // fall through to empty
  }
  return {};
}

/**
 * Watch the view for unresolved client-tool calls and execute them.
 * @param view - The client view whose messages to watch and to publish results on.
 * @param api - The agent endpoint URL to POST the continuation to.
 * @param onLog - Optional callback to surface each execution in the demo's debug log.
 */
export function useClientTools(
  view: ViewHandle<OpenAIInput, OpenAIMessage>,
  api: string,
  onLog?: (summary: string) => void,
) {
  // Track handled call_ids so a re-render doesn't re-run an in-flight executor.
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    const messages = view.messages;
    if (messages.length === 0) return;
    const resolved = resolvedCallIds(messages.map((m) => m.message));

    for (const { codecMessageId, message } of messages) {
      if (message.role !== 'assistant') continue;

      const run = view.runOf(codecMessageId);
      if (!run) continue;
      // Wait until the run is done streaming before executing a client tool and
      // poking the agent to resume it. A single model turn can emit a server
      // tool and a client tool in the same message; resuming while the run is
      // still active races the run's own output (its server-tool result has not
      // folded yet), and the provider rejects the resume for a missing output.
      // The run flips to suspended once the agent pauses it awaiting this input.
      if (run.status !== 'suspended') continue;

      for (const item of message.items) {
        if (item.type !== 'function_call') continue;
        if (!isClientTool(item.name)) continue;
        if (resolved.has(item.call_id)) continue;
        if (handledRef.current.has(item.call_id)) continue;

        handledRef.current.add(item.call_id);
        void executeClientTool(view, api, run.runId, codecMessageId, item, onLog);
      }
    }
  }, [view, view.messages, api, onLog]);
}

/** Run one client-tool call and publish its result (or error) as a continuation. */
async function executeClientTool(
  view: ViewHandle<OpenAIInput, OpenAIMessage>,
  api: string,
  runId: string,
  codecMessageId: string,
  call: Extract<OpenAIItem, { type: 'function_call' }>,
  onLog?: (summary: string) => void,
): Promise<void> {
  const executor = clientTools[call.name];
  if (!executor) return;

  onLog?.(`${call.name} executing`);

  // Compute the resolution input first so an executor failure produces a
  // tool-result-error without entangling the publish/wake error handling.
  let input: OpenAIInput;
  try {
    const output = await executor(parseArgs(call.arguments));
    input = ResponsesCodec.createToolResult(codecMessageId, {
      call_id: call.call_id,
      output: JSON.stringify(output),
    });
    onLog?.(`${call.name} done`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'client tool execution failed';
    input = ResponsesCodec.createToolResultError(codecMessageId, { call_id: call.call_id, message });
    onLog?.(`${call.name} error: ${message}`);
  }

  // Publish the resolution, then wake the agent so it resumes the run.
  const run = await view.send([input], { runId });
  await wakeAgent(api, run);
}
