import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';

/**
 * A lifecycle wire event whose publish is bracketed by
 * {@link publishLifecycleEvent}. Spans both tiers — the run's own lifecycle and
 * the step lifecycle nested within it — because a failed step publish is the
 * same class of failure as a failed run publish and surfaces identically.
 */
export type LifecyclePhase = 'run-start' | 'run-resume' | 'run-suspend' | 'run-end' | 'step-start' | 'step-end';

/**
 * Options identifying the lifecycle publish being bracketed.
 */
export interface PublishLifecycleOptions {
  /** The lifecycle wire phase, named in the error message. */
  phase: LifecyclePhase;
  /** The owning component, prefixing the error log (see LOGGING.md's `ClassName.methodName();` format). */
  component: string;
  /** The method name to prefix the error log with (e.g. `openStep`, `closeStep`). */
  method: string;
  /** The run the event belongs to, named in the error message. */
  runId: string;
  /** Logger for the failure; the phase and `runId` are logged with it. */
  logger?: Logger;
  /** Extra structured context for the failure log (e.g. the step id). */
  logContext?: Record<string, string>;
}

/**
 * Run a lifecycle publish and wrap any failure as a
 * {@link ErrorCode.RunLifecycleEventPublishFailed}, logging at error and
 * rethrowing. Every run- and step-lifecycle publish goes through here so they
 * cannot drift on the error code, message shape, or cause preservation.
 * @param options - Identifies the publish (see {@link PublishLifecycleOptions}).
 * @param publish - The RunManager publish to run.
 * @returns Whatever `publish` resolves with (the ACK serial, for the publishes that report one).
 * @throws {@link Ably.ErrorInfo} with {@link ErrorCode.RunLifecycleEventPublishFailed} if `publish` rejects.
 */
export const publishLifecycleEvent = async <T>(
  options: PublishLifecycleOptions,
  publish: () => Promise<T>,
): Promise<T> => {
  const { phase, component, method, runId, logger, logContext } = options;
  try {
    return await publish();
  } catch (error) {
    const errInfo = new Ably.ErrorInfo(
      `unable to publish ${phase} for run ${runId}; ${errorMessage(error)}`,
      ErrorCode.RunLifecycleEventPublishFailed,
      500,
      errorCause(error),
    );
    logger?.error(`${component}.${method}(); lifecycle publish failed`, {
      phase,
      runId,
      error: errorMessage(error),
      ...logContext,
    });
    throw errInfo;
  }
};
