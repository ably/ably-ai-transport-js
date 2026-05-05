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
  clientId?: string;
  parent?: string;
  forkOf?: string;
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
export const createRunFromOpts = <TEvent, TMessage>(
  session: AgentSession<TEvent, TMessage>,
  opts: RunOpts<TEvent>,
): Run<TEvent, TMessage> => {
  const invocation = Invocation.fromJSON<TEvent, TMessage>({
    runId: opts.runId,
    clientId: opts.clientId ?? '',
    sessionName: 'test',
    messages: [],
    history: [],
    events: [],
    ...(opts.parent !== undefined && { parent: opts.parent }),
    ...(opts.forkOf !== undefined && { forkOf: opts.forkOf }),
  });
  return session.createRun(invocation, {
    signal: opts.signal,
    onMessage: opts.onMessage,
    onAbort: opts.onAbort,
    onCancel: opts.onCancel,
    onError: opts.onError,
  });
};
