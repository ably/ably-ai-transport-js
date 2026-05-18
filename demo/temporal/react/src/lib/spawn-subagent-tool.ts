/**
 * `spawn_subagent` tool factory. The tool is intentionally defined with
 * no `execute` function — the AI SDK emits the model's tool-call into the
 * `UIMessageChunk` stream but does not run anything. The parent workflow
 * sees the unresolved tool call in `result.toolCalls`, starts a Temporal
 * child workflow per call, and feeds the child's final text back to the
 * model as a `tool-output-available` chunk on the next step.
 *
 * The tool is omitted from the toolkit when the current depth is at the
 * limit, so the model literally cannot choose to spawn deeper. The
 * recursion cap is enforced by the toolkit, not by the model's prompt.
 */

import { tool } from 'ai';
import { z } from 'zod';

/** Toolkit-side tool name. Matches the wire toolName the model emits. */
export const SPAWN_SUBAGENT_TOOL_NAME = 'spawn_subagent';

/**
 * Hard cap on subagent recursion depth. `0` is the user-facing root agent;
 * a value of `3` allows root + 2 levels of children before the tool is
 * hidden from the model.
 */
export const MAX_SUBAGENT_DEPTH = 3;

const inputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('Short human-readable label for the subagent task. Shown in the UI alongside the spawn.'),
  prompt: z
    .string()
    .min(1)
    .describe('The full task / instructions for the subagent. Treated as the subagent’s first user message.'),
});

/** Input shape the parent workflow extracts from each spawn tool call. */
export interface SpawnSubagentInput {
  description: string;
  prompt: string;
}

const description = `Spawn a subagent in its own Temporal child workflow to handle a sub-task.

Use when the work decomposes naturally into independent pieces — e.g. "investigate
file X" and "summarise findings" can run in parallel as two subagents.

The subagent has access to the same shell workspace and tools you do. It returns
its final response text once finished. You may spawn multiple subagents in a
single response; they will run in parallel.`;

/**
 * Build the toolkit entry for `spawn_subagent` if the current depth allows
 * further spawning. Returns an empty object at the cap so callers can
 * spread it into their tools record unconditionally.
 *
 * @param depth The current agent's depth (root = 0).
 */
export const spawnSubagentToolFor = (
  depth: number,
): { [SPAWN_SUBAGENT_TOOL_NAME]: ReturnType<typeof tool<SpawnSubagentInput, never>> } | Record<string, never> => {
  if (depth >= MAX_SUBAGENT_DEPTH - 1) {
    return {};
  }
  return {
    [SPAWN_SUBAGENT_TOOL_NAME]: tool<SpawnSubagentInput, never>({
      description,
      inputSchema,
    }),
  };
};
