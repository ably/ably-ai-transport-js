/**
 * Server-side tool-approval helper.
 *
 * The reducer's `_foldToolApproval` already transitions
 * `dynamic-tool` parts on the projection (approved → `approval-responded`,
 * denied → `output-denied`). The agent route still needs to disable
 * `needsApproval` on just-approved tools so `streamText`'s multi-step
 * loop runs the tool instead of pausing on it again.
 *
 * `disableApprovalsForApproved` reads the loaded projection's UIMessages
 * and returns a `tools` dict with that flag cleared on matching entries.
 */

import type * as AI from 'ai';

// ---------------------------------------------------------------------------
// Tool dict mutation
// ---------------------------------------------------------------------------

/**
 * Walk projection messages for `dynamic-tool` parts in `approval-responded`
 * state, collect their `toolName`s, and return the `tools` dict with
 * `needsApproval: false` forced on those entries. Prevents the AI SDK's
 * multi-step loop from re-pausing on a tool the user has already approved.
 *
 * Returns the input dict unchanged when no approvals are detected.
 *
 * The generic uses `object` (not `AI.Tool`) for its value constraint so
 * duplicate peer-dep resolutions — common when the SDK and the consuming app
 * each pull their own copy of `ai` — still type-check. Every real Vercel Tool
 * is structurally an object, so the constraint holds in practice.
 * @param messages - The projection's UIMessages (e.g. from `Codec.getMessages(projection)`).
 * @param tools - The tool dictionary about to be passed to `streamText`.
 * @returns A new tool dict with the flag cleared on approved tools; input returned unchanged when none.
 */
export const disableApprovalsForApproved = <T extends Record<string, object>>(
  messages: readonly AI.UIMessage[],
  tools: T,
): T => {
  const approvedNames = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'dynamic-tool' && part.state === 'approval-responded') {
        approvedNames.add(part.toolName);
      }
    }
  }
  if (approvedNames.size === 0) return tools;

  const entries = Object.entries(tools).map(([name, def]) =>
    approvedNames.has(name) ? ([name, { ...def, needsApproval: false }] as const) : ([name, def] as const),
  );
  // CAST: Object.fromEntries loses the exact T shape in its return type, but
  // we preserve every key and only set an existing optional field, so the T
  // contract holds at runtime.
  return Object.fromEntries(entries) as T;
};
