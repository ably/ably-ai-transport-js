/**
 * The two pure decisions the inference activity makes, split out so they can
 * be unit-tested.
 *
 * The split is not cosmetic: every export of `activities.ts` is registered as
 * a Temporal activity, so a helper that lives there cannot be imported by a
 * test without also becoming part of the worker's activity surface.
 */

import Ably from 'ably';
import { ErrorCode } from '@ably/ai-transport';
import type { AgentRunTransport } from '@ably/ai-transport';
import type { VercelOutput } from '@ably/ai-transport/vercel';

import { tools } from '../app/api/chat/tools.js';
import type { InferenceOutcome, ToolCallInfo } from './shared.js';

/** The run handle an activity re-enters, at this codec's output type. */
type Run = Pick<AgentRunTransport<VercelOutput>, 'end'>;

/**
 * Publish the run lifecycle event an inference outcome implies.
 *
 * A turn left waiting on the client — an unexecuted client tool, an unanswered
 * approval — still ends. The useChat adapter publishes each resolution as a
 * plain input carrying no run id, so the continuation opens a fresh run and a
 * suspended one would never be resumed.
 * @param run - The re-entered run handle.
 * @param outcome - The inference outcome to publish.
 * @returns Resolves once the terminal is on the wire, or immediately for the non-terminal outcome.
 */
export async function publishRunTerminal(run: Run, outcome: InferenceOutcome): Promise<void> {
  switch (outcome.kind) {
    case 'awaiting-client':
      await run.end({ reason: 'complete' });
      return;
    case 'server-tools':
      // The only non-terminal outcome — nothing to publish; the workflow loops
      // with a follow-up inference after its tool steps.
      return;
    case 'error':
      await run.end({
        reason: 'error',
        error: new Ably.ErrorInfo(outcome.errorMessage, ErrorCode.RunResponseStreamFailed, 500),
      });
      return;
    default:
      // publish the terminal reason (complete / cancelled)
      await run.end({ reason: outcome.kind });
  }
}

/**
 * Keep only the calls this worker can execute itself. A tool with no `execute`
 * in the registry is the client's to run, so it never becomes a tool activity.
 * @param calls - The pending tool calls the model emitted.
 * @returns The subset the worker executes, as workflow-serialisable info.
 */
export function filterServerToolCalls(
  calls: readonly { toolCallId: string; toolName: string; input: unknown }[],
): ToolCallInfo[] {
  return calls
    .filter((call) => {
      // CAST: the tool registry is a typed literal; this reads one optional
      // field off an entry looked up by a name that came from the model.
      const entry = (tools as Record<string, { execute?: unknown } | undefined>)[call.toolName];
      return typeof entry?.execute === 'function';
    })
    .map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }));
}
