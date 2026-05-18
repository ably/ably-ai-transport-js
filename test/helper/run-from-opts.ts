/**
 * Test helper that creates a {@link Run} from a flat options object,
 * keeping test bodies terse. Wraps the new
 * `session.createRun(invocation, runtime)` API behind a single-argument
 * shape that captures both invocation identity and per-request runtime.
 */

import type * as Ably from 'ably';

import type { AgentSession, CancelRequest, Run } from '../../src/index.js';
import { Invocation } from '../../src/index.js';

interface RunOpts<TEvent> {
  runId: string;
  invocationId?: string;
  clientId?: string;
  parent?: string;
  forkOf?: string;
  /**
   * Prompt-ids the agent should wait for on the channel. Defaults to `[]`
   * (no prompt lookup, `Run.start` resolves synchronously). Tests that
   * exercise the channel prompt-lookup path supply one or more ids here.
   */
  promptIds?: string[];
  /** Mark the invocation as a continuation (drives `x-ably-run-continue`). */
  isContinuation?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: Ably.Message) => void;
  onAbort?: (write: (event: TEvent) => Promise<void>) => void | Promise<void>;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
}

/**
 * Build a {@link Run} from a flat options object.
 * @param session - The agent session to create the run on.
 * @param opts - Run identity (runId, clientId, parent, forkOf) plus runtime hooks.
 * @returns The created Run.
 */
export const createRunFromOpts = <TEvent, TProjection, TMessage>(
  session: AgentSession<TEvent, TProjection, TMessage>,
  opts: RunOpts<TEvent>,
): Run<TEvent, TProjection, TMessage> => {
  const invocation = Invocation.fromJSON<TMessage>({
    runId: opts.runId,
    invocationId: opts.invocationId ?? `${opts.runId}-inv`,
    clientId: opts.clientId ?? '',
    sessionName: 'test',
    history: [],
    ...(opts.parent !== undefined && { parent: opts.parent }),
    ...(opts.forkOf !== undefined && { forkOf: opts.forkOf }),
    ...(opts.promptIds !== undefined && { promptIds: opts.promptIds }),
    ...(opts.isContinuation !== undefined && { isContinuation: opts.isContinuation }),
  });
  return session.createRun(invocation, {
    signal: opts.signal,
    onMessage: opts.onMessage,
    onAbort: opts.onAbort,
    onCancel: opts.onCancel,
    onError: opts.onError,
  });
};
