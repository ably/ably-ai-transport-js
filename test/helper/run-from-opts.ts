/**
 * Test helper that creates a {@link Run} from a flat options object,
 * keeping test bodies terse. Wraps the new
 * `session.createRun(invocation, runtime)` API behind a single-argument
 * shape that captures both invocation identity and per-request runtime.
 */

import type * as Ably from 'ably';

import type { AgentSession, CancelRequest, CodecInputEvent, CodecOutputEvent, Run } from '../../src/index.js';
import { Invocation } from '../../src/index.js';

interface RunOpts<TOutput extends CodecOutputEvent> {
  runId: string;
  invocationId?: string;
  /** Prompt-id the agent uses to locate the primary trigger event on the channel. */
  eventId?: string;
  signal?: AbortSignal;
  onMessage?: (message: Ably.Message) => void;
  onCancelled?: (write: (event: TOutput) => Promise<void>) => void | Promise<void>;
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
 * transport headers and supply matching `eventIds`. Tests that need a
 * particular `inputClientId` on the agent's published events must publish
 * an input event with that publisher `clientId` on the wire (e.g. via
 * `deliverUserPrompt({ publisherClientId })`).
 * @param session - The agent session to create the run on.
 * @param opts - Run identity (runId, invocationId, eventIds) plus runtime hooks.
 * @returns The created Run.
 */
export const createRunFromOpts = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  session: AgentSession<TInput, TOutput, TProjection, TMessage>,
  opts: RunOpts<TOutput>,
): Run<TInput, TOutput, TProjection, TMessage> => {
  const invocation = Invocation.fromJSON({
    runId: opts.runId,
    invocationId: opts.invocationId ?? `${opts.runId}-inv`,
    eventId: opts.eventId ?? '',
    sessionName: 'test',
  });
  return session.createRun(invocation, {
    signal: opts.signal,
    onMessage: opts.onMessage,
    onCancelled: opts.onCancelled,
    onCancel: opts.onCancel,
    onError: opts.onError,
  });
};
