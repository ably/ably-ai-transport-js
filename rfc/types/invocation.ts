/**
 * A typed data structure carrying preconditions for an agent invocation.
 * Produced by client-side operations that need an agent to act. The developer
 * owns the HTTP transport; the SDK defines the contract on both sides.
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
 * Rehydrate an {@link Invocation} from its serialized form. Used by agent
 * entry points to reconstruct the typed handle from an incoming HTTP body.
 * @param data - The plain object produced by {@link Invocation.toJSON}, typically read from an HTTP request body.
 * @returns An {@link Invocation} carrying the same preconditions.
 */
export declare function createInvocation(data: InvocationData): Invocation;
