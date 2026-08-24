/**
 * useClientTools — runs client-executed tools when they appear unresolved in the
 * conversation and publishes their result so the suspended agent run resumes.
 *
 * Watches the folded thread for a `function_call` whose tool name is a client
 * tool (no server executor; see `isClientTool` in `../api/chat/tools`) that has
 * no `function_call_output` yet, on a run that has suspended. It waits for the
 * run to suspend so a resume never races the run's still-streaming output (a
 * server tool in the same turn whose result has not folded yet). It runs the
 * tool in the browser, then hands a `kind: 'item'` input carrying the
 * `function_call_output` — addressed to the function_call's codec-message-id —
 * to `resolve`, which publishes it and wakes the agent only once every call on
 * the run is answered. The fold appends the output onto that message (paired
 * with its call by `call_id` at render time), and the continuation reuses the
 * run's runId so the agent picks the result up off the channel and resumes.
 *
 * A `function_call_output` already present means the call was resolved (this
 * session or a prior one loaded from history), so the hook skips it and does not
 * re-execute on refresh. The `handledRef` dedup guards against a re-render
 * re-running an in-flight executor. Only the initiating client runs the tool:
 * the run's triggering input (the user message named by the run-start's
 * `inputCodecMessageId`) carries its publisher's clientId, and the gate on it
 * keeps other tabs on the same channel — which see the call but lack the
 * browser context (geolocation) — from answering it.
 */

import { useEffect, useRef } from 'react';
import { resolvedCallIds, type OpenAIItem } from '../lib/openai-thread';

import { isClientTool } from '../api/chat/tools';
import type { RunSummary, ThreadMessage } from '../lib/fold-thread';
import type { ToolResolution } from './use-tool-resolution';

/** Publishes one tool resolution, waking the agent only when the run's last call is answered. */
type ResolveToolCall = (resolution: ToolResolution) => Promise<void>;

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

/** The clientId of the user message that triggered a run, or undefined when unknown. */
function runInitiatorClientId(messages: ThreadMessage[], run: RunSummary): string | undefined {
  if (run.inputCodecMessageId === undefined) return undefined;
  return messages.find((message) => message.codecMessageId === run.inputCodecMessageId)?.clientId;
}

/**
 * Watch the thread for unresolved client-tool calls and execute them.
 * @param messages - The folded thread to watch and to resolve calls against.
 * @param runs - The folded run state, for the suspend gate and initiator lookup.
 * @param clientId - This client's id; only calls from runs it initiated are executed.
 * @param resolve - Publishes the tool result and owns the decision to wake the agent.
 * @param onLog - Optional callback to surface each execution in the demo's debug log.
 */
export function useClientTools(
  messages: ThreadMessage[],
  runs: ReadonlyMap<string, RunSummary>,
  clientId: string | undefined,
  resolve: ResolveToolCall,
  onLog?: (summary: string) => void,
) {
  // Track handled call_ids so a re-render doesn't re-run an in-flight executor.
  const handledRef = useRef(new Set<string>());

  useEffect(() => {
    if (messages.length === 0) return;
    const resolved = resolvedCallIds(messages);

    for (const message of messages) {
      if (message.role !== 'assistant') continue;

      const run = message.runId === undefined ? undefined : runs.get(message.runId);
      if (!run || message.runId === undefined) continue;
      // Only run client tools for runs this client initiated — other tabs see
      // the call but should not answer it.
      const initiator = runInitiatorClientId(messages, run);
      if (initiator !== undefined && initiator !== clientId) continue;
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
        void executeClientTool(resolve, message.codecMessageId, message.runId, item, onLog);
      }
    }
  }, [messages, runs, clientId, resolve, onLog]);
}

/** Run one client-tool call and hand its result (or error) to the resolution gate. */
async function executeClientTool(
  resolve: ResolveToolCall,
  codecMessageId: string,
  runId: string,
  call: Extract<OpenAIItem, { type: 'function_call' }>,
  onLog?: (summary: string) => void,
): Promise<void> {
  const executor = clientTools[call.name];
  if (!executor) return;

  onLog?.(`${call.name} executing`);

  // Compute the output first so an executor failure still produces a
  // function_call_output (with the failure recorded in it) — the item is what
  // the next /responses call consumes either way.
  let output: string;
  try {
    output = JSON.stringify(await executor(parseArgs(call.arguments)));
    onLog?.(`${call.name} done`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'client tool execution failed';
    output = JSON.stringify({ error: message });
    onLog?.(`${call.name} error: ${message}`);
  }

  await resolve({
    codecMessageId,
    runId,
    callId: call.call_id,
    inputs: [{ kind: 'item', payload: { type: 'function_call_output', call_id: call.call_id, output } }],
  });
}
