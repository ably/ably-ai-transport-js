/**
 * Test helper that creates a {@link Run} from a flat options object,
 * keeping test bodies terse. Wraps the new
 * `session.createRun(invocation, runtime)` API behind a single-argument
 * shape that captures both invocation identity and per-request runtime.
 */

import type * as Ably from 'ably';

import type { AgentSession, CancelRequest, Run } from '../../src/index.js';
import { Invocation } from '../../src/index.js';

interface RunOpts<TEvent, TMessage = unknown> {
  runId: string;
  invocationId?: string;
  /**
   * Prompt-ids the agent should wait for on the channel. Defaults to `[]`
   * (no prompt lookup, `Run.start` resolves synchronously). Tests that
   * exercise the channel prompt-lookup path supply one or more ids here.
   */
  eventIds?: string[];
  /** Prior-conversation history seeded onto the invocation. Defaults to `[]`. */
  history?: TMessage[];
  signal?: AbortSignal;
  onMessage?: (message: Ably.Message) => void;
  onAbort?: (write: (event: TEvent) => Promise<void>) => void | Promise<void>;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
}

/**
 * Build a {@link Run} from a flat options object.
 *
 * Per-message metadata (clientId, parent, forkOf, continuation flag) is no
 * longer carried by the invocation body — the agent reads it from the
 * channel via the prompt-lookup result. Tests that exercise those code
 * paths should publish user-messages on the channel with the appropriate
 * transport headers and supply matching `eventIds`.
 * @param session - The agent session to create the run on.
 * @param opts - Run identity (runId, invocationId, eventIds) plus runtime hooks.
 * @returns The created Run.
 */
export const createRunFromOpts = <TEvent, TProjection, TMessage>(
  session: AgentSession<TEvent, TProjection, TMessage>,
  opts: RunOpts<TEvent, TMessage>,
): Run<TEvent, TProjection, TMessage> => {
  const invocation = Invocation.fromJSON<TMessage>({
    runId: opts.runId,
    invocationId: opts.invocationId ?? `${opts.runId}-inv`,
    sessionName: 'test',
    history: opts.history ?? [],
    ...(opts.eventIds !== undefined && { eventIds: opts.eventIds }),
  });
  return session.createRun(invocation, {
    signal: opts.signal,
    onMessage: opts.onMessage,
    onAbort: opts.onAbort,
    onCancel: opts.onCancel,
    onError: opts.onError,
  });
};
