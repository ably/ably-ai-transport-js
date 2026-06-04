/**
 * Vercel-owned per-run output stream.
 *
 * Builds the `ReadableStream<UIMessageChunk>` that `useChat` consumes by
 * subscribing to the session Tree's `output` and `run` events for a single
 * run. Streaming is a useChat-integration concern, so it lives in the Vercel
 * layer rather than the generic core: the core Tree is the fan-out point, and
 * this projects its events into the shape `useChat` expects.
 *
 * Close semantics — the stream the consumer reads ends when:
 * - a **terminal chunk** (`finish` / `error` / `abort`) is folded for the run.
 *   This is the signal `useChat`'s `sendAutomaticallyWhen` waits for, and it
 *   fires even when the run merely *suspends* for a tool call (a tool-calls
 *   `finish` ends the consumer stream while the core run stays alive in the
 *   Tree for the continuation); or
 * - the run reaches `run-end`, which is always terminal (safety net for a run
 *   that ends without emitting a terminal chunk). A `run-suspend` keeps the
 *   core run alive and does not close the consumer stream.
 *
 * It errors when the session emits a non-fatal `error` (e.g. channel
 * continuity loss, or an agent-reported mid-run error), so the consumer's
 * reader rejects rather than hanging.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import type { ClientSession } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../codec/index.js';

type VercelSession = ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

/**
 * Whether a Vercel output chunk ends the consumer-facing stream. The terminal
 * variants are `finish` (end of an LLM turn, including tool-calls), `error`,
 * and `abort`.
 * @param output - The decoded output chunk.
 * @returns True when the chunk should close the consumer stream.
 */
const isTerminalChunk = (output: VercelOutput): boolean =>
  output.type === 'finish' || output.type === 'error' || output.type === 'abort';

/** A consumer-facing run output stream plus the handles to settle it externally. */
export interface RunOutputStream {
  /** The stream of decoded outputs for the run, as `useChat` consumes it. */
  stream: ReadableStream<VercelOutput>;
  /** Close the stream now (e.g. on local cancel). Idempotent. */
  close: () => void;
  /** Error the stream now (e.g. on a failed agent-invocation POST). Idempotent. */
  error: (reason: Ably.ErrorInfo) => void;
}

/**
 * Create a consumer-facing output stream for a send, sourced from the session
 * Tree's events. See the module docs for close/error semantics. The returned
 * `close`/`error` let the caller settle the stream for conditions the Tree
 * doesn't surface (local cancel, POST failure).
 *
 * Outputs route PURELY by the triggering input's codec-message-id — the key the
 * client owns from send time, before the agent mints the runId. The agent's
 * minted runId is supplied as a promise so the run-end safety-net can still
 * close the stream once it resolves.
 * @param session - The Vercel client session whose Tree to observe.
 * @param runId - The agent-minted runId, resolved when run-start is observed.
 *   Used only by the run-end safety-net; routing keys on `inputCodecMessageId`.
 * @param inputCodecMessageId - The triggering input's codec-message-id. An
 *   output routes to this stream when it carries this id.
 * @returns The stream and its external settle handles.
 */
export const createRunOutputStream = (
  session: VercelSession,
  runId: Promise<string>,
  inputCodecMessageId: string,
): RunOutputStream => {
  const holder: { controller?: ReadableStreamDefaultController<VercelOutput> } = {};
  // ReadableStream's start() runs synchronously, so the controller is captured
  // before the constructor returns.
  const unsubscribe: (() => void)[] = [];
  const stream = new ReadableStream<VercelOutput>({
    start: (controller) => {
      holder.controller = controller;
    },
    cancel: () => {
      teardown();
    },
  });
  const { controller } = holder;
  if (!controller) {
    throw new Ably.ErrorInfo(
      'unable to create run stream; ReadableStream start() was not called synchronously',
      ErrorCode.SessionSubscriptionError,
      500,
    );
  }

  // The agent mints the runId; learn it (for the run-end safety-net) when the
  // promise resolves. Fire-and-forget: the stream opens on the input key, so a
  // never-resolving runId only forgoes the safety-net, not normal close.
  let resolvedRunId: string | undefined;
  // Best-effort: failure only disables the run-end safety-net; normal close is
  // the terminal chunk. `void` discards the promise (no await needed here).
  void runId.then(
    (id) => {
      resolvedRunId = id;
    },
    () => {
      /* session closed before run-start; safety-net stays disarmed */
    },
  );

  let settled = false;
  const teardown = (): void => {
    for (const unsub of unsubscribe) unsub();
    unsubscribe.length = 0;
  };
  const close = (): void => {
    if (settled) return;
    settled = true;
    try {
      controller.close();
    } catch {
      /* consumer already cancelled the stream */
    }
    teardown();
  };
  const error = (reason: Ably.ErrorInfo): void => {
    if (settled) return;
    settled = true;
    try {
      controller.error(reason);
    } catch {
      /* consumer already cancelled the stream */
    }
    teardown();
  };

  unsubscribe.push(
    session.tree.on('output', (event) => {
      if (event.inputCodecMessageId !== inputCodecMessageId) return;
      for (const output of event.events) {
        try {
          controller.enqueue(output);
        } catch {
          close();
          return;
        }
        if (isTerminalChunk(output)) {
          close();
          return;
        }
      }
    }),
    session.tree.on('run', (event) => {
      // run-end is always terminal now; a run-suspend (event.type === 'suspend')
      // keeps the core run alive and must not close the consumer stream. Match
      // against the resolved runId once the agent has minted it.
      if (event.type === 'end' && resolvedRunId !== undefined && event.runId === resolvedRunId) {
        close();
      }
    }),
    session.on('error', (reason) => {
      error(reason);
    }),
  );

  return { stream, close, error };
};
