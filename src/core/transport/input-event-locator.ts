/**
 * locateInputEvent — find the channel message that triggered an agent run.
 *
 * Before `Run.start()` publishes run-start, the agent must find the input event
 * (`invocation.inputEventId`) that invoked it, to read the user's message and
 * the per-run metadata (run-id, parent, forkOf, continuation flag, publisher
 * clientId) off its wire headers. The trigger may already be in the Tree (a
 * prior live arrival), may arrive live during the call, or may sit in channel
 * history (published just before the agent attached).
 *
 * The lookup races three sources and resolves with whichever surfaces the
 * expected event-id first:
 *  1. A pre-scan of the Tree's event-id index (`findAblyMessageByEventId`).
 *  2. A live listener on the Tree's `ably-message` event.
 *  3. The shared {@link HistoryHydrator}, driven until the trigger is found —
 *     each page folds into the Tree and surfaces through the same
 *     `ably-message` event, so the live listener catches history arrivals too.
 *
 * The only bound is `timeoutMs`: on timeout the in-flight history scan is
 * cancelled and the lookup rejects with `InputEventNotFound` (wrapping any
 * history-scan failure as `cause` so a broken fetch isn't masked behind the
 * timeout). There is no transport-side "how far back" give-up — the channel's
 * own `untilAttach` exhaustion ends the scan otherwise, and the predicate
 * (`settled`) is the sole "found" signal.
 */

import * as Ably from 'ably';

import { HEADER_EVENT_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage, getTransportHeaders } from '../../utils.js';
import type { HistoryHydrator } from './history-hydrator.js';

/**
 * The Tree capabilities {@link locateInputEvent} reads: the event-id index
 * pre-scan and the `ably-message` subscription. {@link TreeInternal} satisfies
 * it structurally.
 */
export interface InputEventSource {
  /** Look up an already-folded message by its `event-id`, or `undefined`. */
  findAblyMessageByEventId(eventId: string): Ably.InboundMessage | undefined;
  /** Subscribe to raw Ably message arrivals; returns an unsubscribe function. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
}

/**
 * The matched triggering input event's metadata. `Run.start` reads `headers`
 * (run-id, parent, forkOf, continuation flag) and `clientId` (the publisher's
 * Ably channel-level id) to derive per-run metadata. The Tree has already
 * folded the message by the time the lookup resolves, so callers do not decode
 * the raw matched message themselves.
 */
export interface InputEventLookupResult {
  /** Transport headers of the matched input event (run metadata). */
  headers?: Record<string, string>;
  /** Publisher's Ably channel-level `clientId` from the matched input event. */
  clientId?: string;
}

/** Parameters for {@link locateInputEvent}. */
export interface LocateInputEventOptions {
  /** The Tree to pre-scan and subscribe to for the triggering input event. */
  tree: InputEventSource;
  /** The shared history hydrator, driven until the trigger is found. */
  hydrator: HistoryHydrator;
  /** The invocation id this lookup is for (logging / error messages). */
  invocationId: string;
  /** The run id this lookup is for (logging / error messages). */
  runId: string;
  /** The `event-id` the lookup must observe before resolving. */
  expectedEventId: string;
  /** Maximum total wait across the live + history sources. */
  timeoutMs: number;
  /** AbortSignal that aborts the lookup if the run is cancelled. */
  signal: AbortSignal;
  /** Logger for diagnostic output. */
  logger?: Logger;
}

/**
 * Locate the triggering input event for a run. See the file header for the
 * race and the bound.
 * @param opts - Lookup parameters.
 * @returns The matched message's transport headers and publisher clientId.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body IS a Promise executor; async would double-wrap it
export const locateInputEvent = (opts: LocateInputEventOptions): Promise<InputEventLookupResult> => {
  const { tree, hydrator, invocationId, runId, expectedEventId, timeoutMs, signal, logger } = opts;

  // Bounded history fetch in parallel with the live wait; this controller lets
  // the lookup cancel the in-flight fetch on timeout / abort, independently of
  // the run signal.
  const historyController = new AbortController();

  return new Promise<InputEventLookupResult>((resolve, reject) => {
    let settled = false;
    // A genuine history-scan failure (not a cancel-induced abort) recorded so
    // the timeout rejection can surface it as `cause` — the live path may still
    // win the race, so the failure alone doesn't reject.
    let historyError: Ably.ErrorInfo | undefined;
    /* eslint-disable prefer-const -- forward-declared so cleanup() / onCancelled() can reference before the listener register or the timeout schedule has run. */
    let unregisterLive: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | number | undefined;
    /* eslint-enable */

    const cleanup = (): void => {
      if (unregisterLive) unregisterLive();
      if (timer !== undefined) clearTimeout(timer);
      historyController.abort();
      signal.removeEventListener('abort', onCancelled);
    };

    const onCancelled = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Ably.ErrorInfo(`unable to look up input event; run ${runId} was cancelled`, ErrorCode.InvalidArgument, 400),
      );
    };

    const finishOk = (m: Ably.InboundMessage): void => {
      if (settled) return;
      settled = true;
      cleanup();
      logger?.debug('locateInputEvent(); matched input event', { runId, invocationId });
      resolve({ headers: getTransportHeaders(m), clientId: m.clientId });
    };

    // Whether a message is the expected input event.
    const matches = (m: Ably.InboundMessage): boolean => getTransportHeaders(m)[HEADER_EVENT_ID] === expectedEventId;

    signal.addEventListener('abort', onCancelled, { once: true });
    if (signal.aborted) {
      onCancelled();
      return;
    }

    // 1. Pre-scan the Tree's event-id index for an already-folded match.
    //    Multi-run sessions where a prior run folded the message hit here
    //    synchronously.
    const preScanned = tree.findAblyMessageByEventId(expectedEventId);
    if (preScanned) {
      finishOk(preScanned);
      return;
    }

    // 2. Subscribe to the Tree's `ably-message` event for live arrivals. The
    //    hydrator folds first; `emitAblyMessage` notifies subscribers AND
    //    populates the event-id index. Wires folded by the parallel history
    //    scan flow through the same event, so the listener picks them up
    //    uniformly.
    unregisterLive = tree.on('ably-message', (msg) => {
      if (!settled && matches(msg)) finishOk(msg);
    });

    // 3. Drive the shared history hydrator in parallel. Each page folds into the
    //    Tree, triggering the listener above; the scan stops when the trigger is
    //    found (`settled`) or the channel is exhausted, leaving the shared cursor
    //    resumable for a later conversation hydration. A failure is recorded so
    //    the timeout can surface it as `cause`; the live path may still win.
    hydrator
      .foldUntil(() => settled, historyController.signal)
      .catch((error: unknown) => {
        if (settled) return;
        historyError =
          error instanceof Ably.ErrorInfo
            ? error
            : new Ably.ErrorInfo(
                `unable to scan history for input event; ${errorMessage(error)}`,
                ErrorCode.HistoryFetchFailed,
                500,
                errorCause(error),
              );
        logger?.warn('locateInputEvent(); history scan failed (continuing on live path)', {
          error: errorMessage(error),
        });
      });

    // 4. Overall timeout — cancels the in-flight history fetch and rejects with
    //    InputEventNotFound.
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Ably.ErrorInfo(
          `unable to look up input event; input event ${expectedEventId} for invocation ${invocationId} not found within ${String(timeoutMs)}ms`,
          ErrorCode.InputEventNotFound,
          504,
          historyError,
        ),
      );
    }, timeoutMs);
    // Node returns an unref-able Timeout; browsers return a number. Unref so a
    // parked lookup cannot keep a Node process alive by itself.
    if (typeof timer === 'object') timer.unref();
  });
};
