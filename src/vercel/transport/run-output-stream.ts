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

/** A consumer-facing run output stream plus the handle to close it externally. */
interface RunOutputStream {
  /** The stream of decoded outputs for the run, as `useChat` consumes it. */
  stream: ReadableStream<VercelOutput>;
  /** Close the stream now (e.g. on local cancel). Idempotent. */
  close: () => void;
}

/** The shared scaffold behind a settle-once consumer stream. */
interface SettlingStream {
  /** The stream the consumer reads. */
  stream: ReadableStream<VercelOutput>;
  /** The stream's controller (enqueue outputs / inspect desiredSize). */
  controller: ReadableStreamDefaultController<VercelOutput>;
  /** Close the stream once, then run registered cleanup. Idempotent. */
  close: () => void;
  /** Error the stream once with `reason`, then run cleanup. Idempotent. */
  error: (reason: Ably.ErrorInfo) => void;
  /** Register a teardown callback run when the stream settles or is cancelled. */
  registerCleanup: (fn: () => void) => void;
}

/**
 * Build a consumer stream that settles at most once. Both run-output stream
 * factories share this: a `ReadableStream` whose controller is captured
 * synchronously, a `close`/`error` pair that fires the controller action once
 * (swallowing the throw if the consumer already cancelled) and then runs
 * registered cleanup, and consumer-cancel wired to the same cleanup. Each
 * factory layers its own event subscriptions on top via {@link
 * SettlingStream.registerCleanup}.
 * @returns The stream, its controller, settle helpers, and a cleanup registrar.
 */
const createSettlingStream = (): SettlingStream => {
  const holder: { controller?: ReadableStreamDefaultController<VercelOutput> } = {};
  const cleanups: (() => void)[] = [];
  const teardown = (): void => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  };
  // ReadableStream's start() runs synchronously, so the controller is captured
  // before the constructor returns.
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

  let settled = false;
  // Settle the stream at most once: run the controller action (close/error),
  // swallow the throw if the consumer already cancelled, then tear down.
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    try {
      action();
    } catch {
      /* consumer already cancelled the stream */
    }
    teardown();
  };

  return {
    stream,
    controller,
    close: () => {
      settle(() => {
        controller.close();
      });
    },
    error: (reason: Ably.ErrorInfo) => {
      settle(() => {
        controller.error(reason);
      });
    },
    registerCleanup: (fn) => {
      cleanups.push(fn);
    },
  };
};

/**
 * Create a consumer-facing output stream for a send, sourced from the session
 * Tree's events. See the module docs for close/error semantics. The returned
 * `close` lets the caller settle the stream for conditions the Tree doesn't
 * surface (local cancel). Session errors are wired internally to error the
 * stream.
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
 * @returns The stream and its external close handle.
 */
export const createRunOutputStream = (
  session: VercelSession,
  runId: Promise<string>,
  inputCodecMessageId: string,
): RunOutputStream => {
  const { stream, controller, close, error, registerCleanup } = createSettlingStream();

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

  const unsubscribe = [
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
      // run-end is always terminal; a run-suspend (event.type === 'suspend')
      // keeps the core run alive and must not close the consumer stream. Match
      // against the resolved runId once the agent has minted it.
      if (event.type === 'end' && resolvedRunId !== undefined && event.runId === resolvedRunId) {
        close();
      }
    }),
    session.on('error', (reason) => {
      error(reason);
    }),
  ];
  registerCleanup(() => {
    for (const unsub of unsubscribe) unsub();
  });

  return { stream, close };
};

/**
 * How long {@link createDeferredContinuationStream} waits for the observed run
 * to produce its next turn before closing best-effort. Bounds two situations
 * the close signals can't otherwise catch: the tab that published the tool
 * resolution never wakes the agent, or the run advanced and suspended again
 * before this stream subscribed (so neither a fresh `output` nor a `run-end`
 * will fire).
 *
 * On timeout the stream `close()`s — it does NOT error, so the user sees no
 * failure. If the run genuinely never advances, that clean close reopens the
 * `useMessageSync` gate with no new assistant turn in the Tree, so `useChat`
 * re-evaluates `sendAutomaticallyWhen` and resubmits: the wait becomes a slow
 * re-poll, one cycle per timeout, rather than a one-shot give-up. This is
 * deliberate — erroring would surface a spurious failure when the agent is
 * merely slow, and the next cycle picks up the reply once it lands.
 */
export const DEFERRED_CONTINUATION_TIMEOUT_MS = 30_000;

/**
 * Create a chunk-less stream that observes an already-running run rather than
 * sending anything. Used when a continuation derives no inputs because another
 * client already folded the tool resolution into the Tree: there is nothing to
 * send, but useChat must stay in `streaming` (so it neither resubmits in a loop
 * nor opens the `useMessageSync` gate prematurely) until that run produces its
 * next turn.
 *
 * It forwards no outputs — its only job is to close at the right moment, after
 * which `useMessageSync` repaints the overlay from the Tree. It closes on the
 * first of:
 * - a synchronous snapshot showing the run is missing or already terminal (the
 *   Tree is at rest; close on a microtask so the consumer attaches first);
 * - a new `output` for the run (the agent resumed and is producing the turn);
 * - `run-end` for the run (clean finish, or a finish with no further output);
 * - {@link DEFERRED_CONTINUATION_TIMEOUT_MS} elapsing (best-effort floor).
 *
 * It errors when the session emits an `error`, mirroring
 * {@link createRunOutputStream}.
 * @param session - The Vercel client session whose Tree to observe.
 * @param runId - The run to observe (the continuation's reused runId), or
 *   `undefined` when none is known — in which case the stream closes immediately.
 * @returns The stream and its external close handle.
 */
export const createDeferredContinuationStream = (
  session: VercelSession,
  runId: string | undefined,
): RunOutputStream => {
  const { stream, close, error, registerCleanup } = createSettlingStream();

  // Snapshot pre-check (closes the subscribe-after-the-fact race): the run's
  // resume/turn/run-end can arrive over the channel before this stream
  // subscribes. If there is no run to observe, or it has already left its live
  // states, the Tree is at rest and holds whatever the other tab drove, so
  // close — on a microtask, so the consumer's reader is attached first.
  const runNode = runId === undefined ? undefined : session.tree.getRunNode(runId);
  const status = runNode?.state.status;
  const isLive = status === 'active' || status === 'suspended';
  if (!isLive) {
    queueMicrotask(close);
    return { stream, close };
  }

  const unsubscribe = [
    session.tree.on('output', (event) => {
      // `runId` is defined here (the pre-check returned otherwise); compare
      // explicitly so this does not rely on the pre-check to exclude input
      // folds, which carry `event.runId === undefined`.
      if (runId !== undefined && event.runId === runId) close();
    }),
    session.tree.on('run', (event) => {
      if (event.type === 'end' && event.runId === runId) close();
    }),
    session.on('error', (reason) => {
      error(reason);
    }),
  ];
  const timer = setTimeout(close, DEFERRED_CONTINUATION_TIMEOUT_MS);
  registerCleanup(() => {
    clearTimeout(timer);
    for (const unsub of unsubscribe) unsub();
  });

  return { stream, close };
};
