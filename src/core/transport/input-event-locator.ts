/**
 * locateInputEvent — watch for the channel message that triggered an agent run.
 *
 * Before `Run.start()` publishes run-start, the agent must find the input event
 * (`invocation.inputEventId`) that invoked it, to read the user's message and
 * the per-run metadata (run-id, parent, forkOf, continuation flag, publisher
 * clientId) off its wire headers. The trigger may already be in the Tree (a
 * prior live arrival), may arrive live during the call, or may sit in channel
 * history (published just before the agent attached).
 *
 * This is a passive watcher — it never pages history itself. It resolves with
 * whichever of two sources surfaces the expected event-id first:
 *  1. A pre-scan of the Tree's event-id index (`findAblyMessageByEventId`).
 *  2. A live listener on the Tree's `ably-message` event.
 *
 * History is paged by the one history-pagination driver — `run.view.loadOlder()`
 * — and every paged fold surfaces through the same `ably-message` event, so a
 * trigger walked back from channel history is caught by the live listener too.
 * The watcher has no deadline: it resolves on a match and otherwise rejects only
 * when `signal` aborts (the run is cancelled or the session closes). Callers that
 * want a deadline race the returned promise against their own timeout.
 */

import * as Ably from 'ably';

import { HEADER_EVENT_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';

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
 * folded the message by the time the watcher resolves, so callers do not decode
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
  /** The invocation id this lookup is for (logging / error messages). */
  invocationId: string;
  /** The run id this lookup is for (logging / error messages). */
  runId: string;
  /** The `event-id` the watcher must observe before resolving. */
  expectedEventId: string;
  /** AbortSignal that aborts the watcher if the run is cancelled / session closes. */
  signal: AbortSignal;
  /**
   * Called synchronously the instant the trigger is matched — inside the fold
   * that surfaced it, before the returned promise resolves. The agent uses this
   * to pin `run.view` and resolve per-run metadata while the fold is still on the
   * stack, so a concurrent `loadOlder` walk sees the pinned branch immediately
   * (rather than a microtask later). Mutate nothing the watcher relies on.
   */
  onMatched?: (result: InputEventLookupResult) => void;
  /** Logger for diagnostic output. */
  logger?: Logger;
}

/**
 * Watch for the triggering input event for a run. See the file header for the
 * two sources and the abort-only bound.
 * @param opts - Watcher parameters.
 * @returns The matched message's transport headers and publisher clientId.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body IS a Promise executor; async would double-wrap it
export const locateInputEvent = (opts: LocateInputEventOptions): Promise<InputEventLookupResult> => {
  const { tree, invocationId, runId, expectedEventId, signal, onMatched, logger } = opts;

  return new Promise<InputEventLookupResult>((resolve, reject) => {
    let settled = false;
    // Forward-declared so cleanup() / onCancelled() can reference it before the
    // listener is registered.
    // eslint-disable-next-line prefer-const
    let unregisterLive: (() => void) | undefined;

    const cleanup = (): void => {
      if (unregisterLive) unregisterLive();
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
      const result: InputEventLookupResult = { headers: getTransportHeaders(m), clientId: m.clientId };
      // Synchronous hook (run inside the surfacing fold) before the promise
      // resolves, so the agent can pin run.view while the fold is on the stack.
      onMatched?.(result);
      resolve(result);
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

    // 2. Subscribe to the Tree's `ably-message` event for arrivals. The Tree
    //    emits it for every fold — a post-attach live publish OR a page the
    //    history-pagination driver (`run.view.loadOlder()`) walks back into the
    //    Tree — so both paths surface the trigger here uniformly.
    unregisterLive = tree.on('ably-message', (msg) => {
      if (!settled && matches(msg)) finishOk(msg);
    });
  });
};
