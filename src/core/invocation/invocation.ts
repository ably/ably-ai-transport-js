import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';

/**
 * Plain-object representation of an invocation, suitable for JSON
 * serialization. Produced by {@link Invocation.toJSON}; consumed by
 * {@link Invocation.fromJSON}.
 */
export interface InvocationData {
  /** The session name the agent should open. */
  sessionName: string;
  /** The run ID the agent should act on. */
  runId: string;
  /** Optional step ID — targets a specific prior step for resumption. */
  stepId?: string;
  /** Optional message ID — the agent waits for this message to be visible. */
  messageId?: string;
}

/**
 * A typed data structure carrying preconditions for an agent invocation.
 * Produced by client-side operations that need an agent to act, consumed
 * by the agent entry point. The developer owns the HTTP transport; the
 * SDK defines the contract on both sides.
 *
 * Construct one from a wire payload via {@link Invocation.fromJSON}; in a
 * later phase, `ClientRun.toInvocation()` will produce one from a live run.
 */
export interface Invocation {
  /** The session name the agent should open. */
  readonly sessionName: string;

  /** The run ID the agent should act on. */
  readonly runId: string;

  /** Optional step ID — targets a specific prior step for resumption. */
  readonly stepId?: string;

  /** Optional message ID — the agent waits for this message to be visible. */
  readonly messageId?: string;

  /**
   * Serialize to a plain object for HTTP transport. The result round-trips
   * through {@link Invocation.fromJSON}.
   * @returns A new {@link InvocationData} carrying the same fields.
   */
  toJSON(): InvocationData;
}

/**
 * Static surface on the {@link Invocation} value namespace. Keeps
 * construction on the same identifier callers read the type from, so
 * invocation-related code clusters under `Invocation.*` rather than a
 * mix of interface references and loose functions.
 */
export interface InvocationConstructor {
  /**
   * Rehydrate an {@link Invocation} from its serialized form. Used by
   * agent entry points to reconstruct the typed handle from an incoming
   * HTTP request body.
   *
   * `fromJSON` sits at a trust boundary: the input is treated as untrusted
   * even though the parameter type names {@link InvocationData}. Missing
   * required fields or wrong types throw with
   * {@link ErrorCode.InvocationInvalid}.
   * @param data The plain object produced by {@link Invocation.toJSON},
   *   typically read from an HTTP request body.
   * @returns An {@link Invocation} carrying the same preconditions.
   * @throws An `Ably.ErrorInfo` with code
   *   {@link ErrorCode.InvocationInvalid} when `data` does not describe a
   *   valid invocation.
   */
  fromJSON(data: InvocationData): Invocation;
}

const STATUS_BAD_REQUEST = 400;

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Ably.ErrorInfo(
      `unable to construct invocation; ${field} must be a non-empty string`,
      ErrorCode.InvocationInvalid,
      STATUS_BAD_REQUEST,
    );
  }
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Ably.ErrorInfo(
      `unable to construct invocation; ${field} must be a non-empty string when present`,
      ErrorCode.InvocationInvalid,
      STATUS_BAD_REQUEST,
    );
  }
  return value;
};

const fromJSON = (data: InvocationData): Invocation => {
  // CAST: `fromJSON` sits at the trust boundary. The parameter type names
  // `InvocationData`, but in practice the value originates from
  // `JSON.parse` on an HTTP body — narrow defensively before reading.
  const raw = data as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Ably.ErrorInfo(
      'unable to construct invocation; data must be a plain object',
      ErrorCode.InvocationInvalid,
      STATUS_BAD_REQUEST,
    );
  }
  const record = raw as Record<string, unknown>;

  const sessionName = requireString(record.sessionName, 'sessionName');
  const runId = requireString(record.runId, 'runId');
  const stepId = optionalString(record.stepId, 'stepId');
  const messageId = optionalString(record.messageId, 'messageId');

  return {
    sessionName,
    runId,
    stepId,
    messageId,
    toJSON: (): InvocationData => {
      const result: InvocationData = { sessionName, runId };
      if (stepId !== undefined) {
        result.stepId = stepId;
      }
      if (messageId !== undefined) {
        result.messageId = messageId;
      }
      return result;
    },
  };
};

/**
 * Value binding for the {@link Invocation} namespace. TypeScript's
 * declaration merging puts this `const` and the interface of the same
 * name into separate namespaces, so callers can write
 * `Invocation.fromJSON(data)` while continuing to use `Invocation` as a
 * type.
 */
export const Invocation: InvocationConstructor = { fromJSON };
