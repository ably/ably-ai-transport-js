/**
 * Client-side tool registry and executor for the demos.
 *
 * The demos declare browser-executed tools here (e.g. getLocation, which
 * needs the browser's geolocation permission). A demo wires the executor into
 * useChat's `onToolCall`: it checks `hasClientTool`, runs the tool via
 * `runClientTool`, and feeds the result to `chat.addToolOutput` (or the error
 * variant). The useChat adapter then publishes the resolution on the channel.
 *
 * Each execution is reported via the optional `onExecute` callback — once
 * with status `executing` when the tool starts, then again with `done` (and
 * output) or `error` once the executor settles. This is driven by the actual
 * execution path, so it reflects which client truly ran the tool — something
 * the replicated conversation state cannot show.
 */

import type { ClientToolLogEntry } from '../components/debug-pane';

/** Runs one browser-side tool call and resolves its output. */
export type ClientToolExecutor = (input: unknown) => Promise<unknown>;

/** A set of browser-executed tools, keyed by tool name. */
export type ClientToolRegistry = Record<string, ClientToolExecutor>;

/**
 * The tools the demos execute in the browser. Module-private so nothing
 * mutates it: both entry points take an optional registry instead, which is
 * how the tests supply throwaway executors.
 */
const builtInTools: ClientToolRegistry = {
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

/**
 * Whether a client-side executor is registered for this tool name.
 * @param toolName - The tool name the model called.
 * @param registry - The tools to look in. Defaults to the demos' built-ins.
 * @returns True when the browser can run this tool.
 */
export function hasClientTool(toolName: string, registry: ClientToolRegistry = builtInTools): boolean {
  return Object.hasOwn(registry, toolName);
}

/**
 * Execute a registered client tool and report the execution's lifecycle.
 * @param toolName - The tool to run; must be registered in `registry`.
 * @param toolCallId - The AI SDK tool-call id, threaded into each log entry.
 * @param input - The tool input the model produced.
 * @param onExecute - Receives an `executing` entry when the tool starts, then
 * a `done` or `error` entry once it settles.
 * @param registry - The tools to run from. Defaults to the demos' built-ins.
 * @returns `{ output }` on success, `{ errorText }` when the tool is not
 * registered or the executor throws.
 */
export async function runClientTool(
  toolName: string,
  toolCallId: string,
  input: unknown,
  onExecute?: (entry: ClientToolLogEntry) => void,
  registry: ClientToolRegistry = builtInTools,
): Promise<{ output: unknown } | { errorText: string }> {
  const executor = registry[toolName];
  if (!executor) {
    return { errorText: `no client tool registered for ${toolName}` };
  }

  const startedAt = Date.now();
  onExecute?.({
    time: startedAt,
    toolName,
    toolCallId,
    input,
    status: 'executing',
  });

  try {
    const output = await executor(input);
    onExecute?.({
      time: startedAt,
      toolName,
      toolCallId,
      input,
      status: 'done',
      output,
    });
    return { output };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Client tool execution failed';
    onExecute?.({
      time: startedAt,
      toolName,
      toolCallId,
      input,
      status: 'error',
      error: message,
    });
    return { errorText: message };
  }
}
