/**
 * AIT-742 Phase 0 spike — `toResponsesInput` and the run-outcome mapper.
 *
 * `toResponsesInput` is near-identity (§5): the conversation is `TMessage[]`
 * (turns of OpenAI items), and OpenAI's output items are *already* valid input
 * items, so the model input is just every turn's items concatenated in order.
 * Nothing to split, no per-item translation — the only shaping is wrapping a
 * user turn's items (which we model as plain content) is unnecessary because we
 * already store user turns as `message` items too.
 */

import type { OpenAITurn } from './events.js';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

/** Flatten a conversation (`TMessage[]`) into Responses model input. */
export const toResponsesInput = (turns: OpenAITurn[]): ResponseInputItem[] => {
  const input: ResponseInputItem[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      // Each item is already a valid ResponseInputItem (output message,
      // function_call, function_call_output, …). Identity copy.
      input.push(item as ResponseInputItem);
    }
  }
  return input;
};

/** Coarse run outcome, mirroring `vercelRunOutcome`. */
export type RunOutcome = 'complete' | 'suspend' | 'error' | 'cancelled';

/** Inputs the agentic loop feeds the mapper after a `/responses` call settles. */
export interface RunOutcomeInputs {
  /** Terminal response status, if the response settled (`completed`/`failed`/`incomplete`). */
  status?: 'completed' | 'failed' | 'incomplete';
  /** Whether a stream-level `error` event or a network/SDK throw occurred. */
  errored?: boolean;
  /** Whether the run was aborted (client cancel). */
  aborted?: boolean;
  /** Whether the settled response left a tool call awaiting a client-side result/approval. */
  pendingClientTool?: boolean;
}

/**
 * Map a settled `/responses` call to a terminal run action. This is the
 * `vercelRunOutcome` analogue and lives entirely outside core.
 */
export const openaiRunOutcome = (inputs: RunOutcomeInputs): RunOutcome => {
  if (inputs.aborted) return 'cancelled';
  if (inputs.errored || inputs.status === 'failed') return 'error';
  if (inputs.pendingClientTool) return 'suspend';
  // `incomplete` (stopped early, e.g. max tokens) is not strictly an error;
  // treat as complete for the run's purposes.
  return 'complete';
};
