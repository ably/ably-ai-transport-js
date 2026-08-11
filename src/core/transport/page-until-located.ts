/**
 * Bounded history paging for a freshly created run.
 *
 * A process that opens a run may not have been attached when the triggering
 * input was published, so that event sits in channel history rather than the
 * live stream. The input watcher is passive and never pages itself, so
 * something has to page history until the trigger surfaces. A durable activity
 * hits this every time, because each attempt is a fresh process.
 *
 * This pages until `run.located` settles, and no further: opening a run needs
 * no inference, so it never needs the rest of the conversation, and the trigger
 * is the newest thing in that history. Opening a run therefore costs about one
 * history page whatever the conversation's length.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';

/**
 * The part of a run this needs. A structural upper bound so callers do not have
 * to thread their codec generics through; every `AgentRun` satisfies it.
 */
export interface LocatableRun {
  /** Settles once the run's trigger event has folded in. */
  readonly located: Promise<void>;
  /** The run's view, used to page channel history backwards. */
  readonly view: {
    /** Whether older history remains unrevealed. */
    hasOlder(): boolean;
    /** Reveal an older page. */
    loadOlder(limit?: number): Promise<unknown>;
  };
}

/** Options for {@link pageUntilLocated}. */
export interface PageUntilLocatedOptions {
  /**
   * The triggering input event's id, used only in the error message when the
   * trigger is never found.
   */
  inputEventId: string;
  /** Most history pages to fetch before giving up. Defaults to 20. */
  maxPages?: number;
  /** CodecMessages to reveal per page. Defaults to 100. */
  pageSize?: number;
  /**
   * How long to keep waiting for the trigger to arrive live once history is
   * exhausted, in milliseconds. Defaults to 5000.
   */
  triggerWaitMs?: number;
  /**
   * Called once per page fetched. Use it to heartbeat a long paging run so the
   * framework can tell slow from hung.
   */
  onPage?: () => void;
  /** Logger for the paging diagnostics. */
  logger?: Logger;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TRIGGER_WAIT_MS = 5000;

/**
 * Page channel history until the run's trigger event is located.
 *
 * Races each page against `run.located` so it stops the instant the trigger
 * surfaces. When history is exhausted without it, waits a short while longer in
 * case the trigger is still in flight, then gives up.
 * @param run - The freshly created run whose trigger sits in channel history.
 * @param options - Paging bounds and diagnostics.
 * @throws {Ably.ErrorInfo} When the trigger is not located within the bounds.
 */
export const pageUntilLocated = async (run: LocatableRun, options: PageUntilLocatedOptions): Promise<void> => {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const triggerWaitMs = options.triggerWaitMs ?? DEFAULT_TRIGGER_WAIT_MS;
  const logger = options.logger?.withContext({ component: 'pageUntilLocated' });
  logger?.trace('pageUntilLocated();', { inputEventId: options.inputEventId, maxPages });

  // Object wrapper so the loop condition is not flow-narrowed to its initial
  // value; the flag is only ever mutated inside the settle callbacks below.
  const state = { located: false };
  const markLocated = (): void => {
    state.located = true;
  };
  // Tag both arms: a rejection is surfaced by the final `await run.located`, not
  // here, so the loop can tell "settled" from "page finished first".
  const locatedTag = run.located.then(markLocated, markLocated);
  // Yield once so an ALREADY-settled `located` marks the flag before the loop
  // reads it. Without this, a trigger that arrived live still costs one page.
  await Promise.resolve();

  let pages = 0;
  while (!state.located && run.view.hasOlder() && pages < maxPages) {
    pages++;
    options.onPage?.();
    await Promise.race([run.view.loadOlder(pageSize), locatedTag]);
  }

  // History ran out before the trigger appeared. It may still be in flight, so
  // give the live stream a bounded moment rather than failing immediately.
  if (!state.located) {
    logger?.debug('pageUntilLocated(); history exhausted, awaiting live trigger', { pages, triggerWaitMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, triggerWaitMs);
    });
    try {
      await Promise.race([locatedTag, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!state.located) {
    throw new Ably.ErrorInfo(
      `unable to open run; trigger event ${options.inputEventId} not located within ${String(pages)} history pages`,
      ErrorCode.InputEventNotFound,
      504,
    );
  }

  // Surface a located rejection (a cancel, or the session closing).
  await run.located;
  logger?.debug('pageUntilLocated(); trigger located', { pages });
};
