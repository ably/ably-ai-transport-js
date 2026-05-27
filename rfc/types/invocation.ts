/**
 * A typed data structure carrying preconditions for an agent invocation.
 * Produced by client-side operations that need an agent to act. The developer
 * owns the HTTP transport; the SDK defines the contract on both sides.
 *
 * Construct one from a wire payload via {@link Invocation.fromJSON}; construct
 * one from a live run via `run.toInvocation()` (see
 * {@link Run.toInvocation}).
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

  /** Serialize to a plain object for HTTP transport. */
  toJSON(): InvocationData;
}

/** Plain object representation of an invocation, suitable for JSON serialization. */
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
 * Static surface on the {@link Invocation} value namespace. Keeps the
 * construction path on the same identifier callers read the type from, so
 * invocation-related code clusters under `Invocation.*` rather than a mix
 * of interface references and loose functions.
 */
export interface InvocationConstructor {
  /**
   * Rehydrate an {@link Invocation} from its serialized form. Used by agent
   * entry points to reconstruct the typed handle from an incoming HTTP
   * request body.
   * @param data - The plain object produced by {@link Invocation.toJSON},
   *   typically read from an HTTP request body.
   * @returns An {@link Invocation} carrying the same preconditions.
   * @throws An `Ably.ErrorInfo` with code
   *   {@link ErrorCode.InvocationInvalid} when `data` does not describe a
   *   valid invocation (e.g. missing `sessionName` or `runId`).
   */
  fromJSON(data: InvocationData): Invocation;
}

/**
 * Value binding for the {@link Invocation} namespace. TypeScript merges this
 * `const` with the interface of the same name, so callers can write
 * `Invocation.fromJSON(data)` while continuing to reference `Invocation` as
 * a type. No bare `createInvocation` function is exported.
 */
export declare const Invocation: InvocationConstructor;
