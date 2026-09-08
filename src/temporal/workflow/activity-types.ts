/**
 * The contract between the framing activities and the workflow-side shim.
 *
 * Types only. This file is imported by both halves, and the workflow half runs
 * inside Temporal's V8 sandbox, so every import here must be `import type` —
 * type imports are erased, leaving the workflow bundle free of `ably` and
 * `@temporalio/activity`.
 *
 * Activity inputs and outputs also cross a serialisation boundary, so they carry
 * plain data only: an `Ably.ErrorInfo` becomes an `errorMessage` string.
 */

import type { InvocationData } from '../../core/transport/invocation.js';
import type { RunEndReason } from '../../core/transport/types/shared.js';
import type { RunIdentity } from '../../core/transport/types/transport.js';

/** Input to the `openRun` activity. */
export interface OpenRunInput {
  /** The invocation this run serves; its `channelName` is the channel. */
  invocation: InvocationData;
  /**
   * The run's invocation id. Also used as the run id, which is what makes a
   * fresh-process retry re-enter the same run instead of opening a parallel one.
   */
  invocationId: string;
}

/** Input to the `endRun` activity. */
export interface EndRunInput {
  /** The open run's identity, as returned by `openRun`. */
  ids: RunIdentity;
  /** The invocation this activity serves; only its `channelName` is read, to resolve the channel. */
  invocation: InvocationData;
  /** The terminal reason to publish. */
  reason: RunEndReason;
  /** Message for the published error, used only when `reason` is `'error'`. */
  errorMessage?: string;
}

/** Input to the `suspendRun` activity. */
export interface SuspendRunInput {
  /** The open run's identity, as returned by `openRun`. */
  ids: RunIdentity;
  /** The invocation this activity serves; only its `channelName` is read, to resolve the channel. */
  invocation: InvocationData;
}

/** Input to the `cleanupRun` activity. */
export interface CleanupRunInput {
  /** The open run's identity, as returned by `openRun`. */
  ids: RunIdentity;
  /** The invocation this activity serves; only its `channelName` is read, to resolve the channel. */
  invocation: InvocationData;
  /** Message for the published error; a default is used when omitted. */
  errorMessage?: string;
}

/**
 * The activities the plugin registers. The shim proxies these by type; consumers
 * never import their implementations.
 */
export interface FramingActivities {
  /**
   * Create the run, locate its trigger, and publish the opening event
   * (`ai-run-start` for a fresh run, `ai-run-resume` for a continuation).
   * @param input - The invocation and the id to pin the run to.
   * @returns The run's identity, to thread through every later activity.
   */
  openRun(input: OpenRunInput): Promise<RunIdentity>;
  /**
   * Adopt the run and publish its terminal.
   * @param input - The run's identity, its invocation, and the terminal reason.
   */
  endRun(input: EndRunInput): Promise<void>;
  /**
   * Adopt the run and publish `ai-run-suspend`.
   * @param input - The run's identity and its invocation.
   */
  suspendRun(input: SuspendRunInput): Promise<void>;
  /**
   * Best-effort failure cleanup: adopt the run and end it as `error` so a
   * waiting client unsticks. Reads no wire state first, so it publishes over an
   * already-ended run (a second terminal a reader ignores) and over one parked
   * by `suspendRun` (which replaces the park with an error terminal).
   * @param input - The run's identity, its invocation, and the failure message.
   */
  cleanupRun(input: CleanupRunInput): Promise<void>;
}
