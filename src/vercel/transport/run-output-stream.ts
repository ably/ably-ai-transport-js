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
 * - the run reaches a non-suspended `run-end` (safety net for a run that ends
 *   without emitting a terminal chunk).
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
 * Create a consumer-facing output stream for the run identified by `key`,
 * sourced from the session Tree's events. See the module docs for close/error
 * semantics. The returned `close`/`error` let the caller settle the stream for
 * conditions the Tree doesn't surface (local cancel, POST failure).
 *
 * The run is keyed by its stable Tree `key` (the triggering input's
 * codec-message-id, which `ActiveRun.key` exposes) because the agent mints the
 * runId and the client doesn't know it at send time. The Tree's `output`
 * events carry that key. The run's `run-end`, however, carries the
 * agent-minted runId — so the stream learns that runId from the run's
 * `run-start` (which echoes the key as `input-codec-message-id`) and matches
 * the terminal `run-end` against it.
 * @param session - The Vercel client session whose Tree to observe.
 * @param key - The stable Tree key of the run whose outputs to project.
 * @returns The stream and its external settle handles.
 */
export const createRunOutputStream = (session: VercelSession, key: string): RunOutputStream => {
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

  // The agent-minted runId of this run, learned from its run-start so the
  // terminal run-end (which carries the runId, not the key) can be matched.
  let adoptedRunId: string | undefined;
  unsubscribe.push(
    session.tree.on('output', (event) => {
      // The Tree emits `output` keyed by the run key.
      if (event.runId !== key) return;
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
      if (event.type === 'start') {
        // Learn this run's agent-minted runId. The adopting run-start echoes
        // the key as `input-codec-message-id`; a legacy/equal run has
        // `runId === key`.
        if (event.inputCodecMessageId === key || event.runId === key) {
          adoptedRunId = event.runId;
        }
        return;
      }
      // run-end carries the agent runId; match it against the learned runId
      // (or the key, when they coincide).
      if (event.reason !== 'suspended' && (event.runId === adoptedRunId || event.runId === key)) {
        close();
      }
    }),
    session.on('error', (reason) => {
      error(reason);
    }),
  );

  return { stream, close, error };
};
