/**
 * Test helper that creates an {@link OpenableRun} from a flat options object,
 * keeping test bodies terse. Wraps the
 * `session.createRun(invocation, identity, hooks)` API behind a single-argument
 * shape that captures the trigger, the run's identity, and its hooks.
 */

import type * as Ably from 'ably';

import type { CodecOutputEvent } from '../../src/core/transport/session-codec.js';
import type { AgentSession, CancelRequest, OpenableRun } from '../../src/index.js';
import { Invocation } from '../../src/index.js';

interface RunOpts<TOutput extends CodecOutputEvent> {
  runId: string;
  invocationId?: string;
  /** Input-event id the agent uses to locate the primary trigger event on the channel. */
  inputEventId?: string;
  signal?: AbortSignal;
  onAblyMessage?: (message: Ably.Message) => void;
  onCancelled?: (write: (event: TOutput) => Promise<void>) => void | Promise<void>;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
  onSteer?: () => void;
}

/**
 * Build an {@link OpenableRun} from a flat options object.
 *
 * Per-message metadata (clientId, parent, forkOf, continuation flag) is no
 * longer carried by the invocation body — the agent reads it from the
 * channel via the input-event lookup result. Tests that exercise those code
 * paths should publish user-messages on the channel with the appropriate
 * transport headers and supply matching `inputEventIds`. Tests that need a
 * particular `inputClientId` on the agent's published events must publish
 * an input event with that publisher `clientId` on the wire (e.g. via
 * `deliverInputEvent({ publisherClientId })`).
 * @param session - The agent session to create the run on.
 * @param opts - Run identity (runId, invocationId, inputEventIds) plus run hooks.
 * @returns The created OpenableRun.
 */
export const createRunFromOpts = <TOutput extends CodecOutputEvent, TProjection, TMessage>(
  session: AgentSession<TOutput, TProjection, TMessage>,
  opts: RunOpts<TOutput>,
): OpenableRun<TOutput, TProjection, TMessage> => {
  const invocation = Invocation.fromJSON({
    inputEventId: opts.inputEventId ?? '',
    sessionName: 'test',
  });
  // The invocation body carries no run-id. The agent mints a fresh run-id (or
  // reads a continuation's off the channel); tests pin both the fresh run-id and
  // the invocation-id deterministically through the identity argument. A
  // continuation test additionally delivers an input event stamped with the wire
  // run-id, which the agent adopts over the pinned identity.runId.
  return session.createRun(
    invocation,
    { runId: opts.runId, invocationId: opts.invocationId ?? `${opts.runId}-inv` },
    {
      signal: opts.signal,
      onAblyMessage: opts.onAblyMessage,
      onCancelled: opts.onCancelled,
      onCancel: opts.onCancel,
      onError: opts.onError,
      onSteer: opts.onSteer,
    },
  );
};
