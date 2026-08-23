/**
 * Session scaffold for one unit of durable work.
 *
 * A durable activity gets a fresh agent session, does its work, and hands any
 * still-open run to whatever runs next. This wraps that shape so the teardown
 * discipline lives in one place.
 */

import { createAgentSession } from './agent-session.js';
import { Invocation } from './invocation.js';
import type { CodecInputEvent, CodecOutputEvent } from './session-codec.js';
import type { AgentSessionContext, WithAgentSessionOptions } from './types/agent.js';

/**
 * Create a connected agent session for the given invocation, run `body` against
 * it, then detach.
 *
 * The session is **detached, never ended**, on both success and failure. Detach
 * publishes nothing, so a run the body left open stays open on the wire and a
 * later attempt can adopt it and publish a superseding step under the same
 * `stepId`. Ending would publish `ai-run-end` and mark the run terminal, so
 * every retry would then fail. When ending the run *is* the intent — a cleanup
 * path that has given up — the body calls `session.end()` itself; the teardown
 * detach is then a no-op.
 *
 * The caller owns the Ably client, as everywhere else in this SDK: pass a
 * connected client in `options.client` and close it yourself once this resolves.
 *
 * A failure to detach is swallowed and logged at debug. Detach publishes
 * nothing, so it cannot leave the wire inconsistent, and surfacing it would
 * either mask the body's own error or fail a unit of work whose output already
 * landed.
 * @template TInput - The codec input event type.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @template T - The body's return type, passed through to the caller.
 * @param options - Session configuration, including the invocation to serve.
 * @param body - The work to run against the connected session. Receives the
 *   session and the parsed invocation, and owns the run: it decides whether to
 *   create or adopt, whether to pass a cancellation signal, whether to load and
 *   page history, and publishes any run terminal itself.
 * @returns Whatever `body` returns.
 */
export const withAgentSession = async <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
  T,
>(
  options: WithAgentSessionOptions<TInput, TOutput, TProjection, TMessage>,
  body: (context: AgentSessionContext<TOutput, TProjection, TMessage>) => Promise<T>,
): Promise<T> => {
  const { invocation: invocationData, ...sessionOptions } = options;
  const invocation = Invocation.fromJSON(invocationData);
  const logger = options.logger?.withContext({ component: 'withAgentSession' });
  logger?.trace('withAgentSession();', { sessionName: invocation.sessionName });

  const session = createAgentSession({ ...sessionOptions, channelName: invocation.sessionName });
  try {
    await session.connect();
    // `await` here, not a bare return: the finally must not run until the body
    // settles, or the detach races the work still in flight.
    return await body({ session, invocation });
  } finally {
    try {
      await session.detach();
    } catch (error) {
      // Best-effort: detach publishes nothing, so a failure here cannot change
      // what reached the channel.
      logger?.debug('withAgentSession(); session detach failed', { error });
    }
  }
};
