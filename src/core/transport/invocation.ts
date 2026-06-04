/**
 * Invocation — value object wrapping the JSON body that a client sends to
 * an agent's HTTP endpoint to start a run.
 *
 * The data shape is the wire contract; the {@link Invocation} class is a
 * runtime view of that data with the same fields. {@link Invocation.fromJSON}
 * is the entry point used by agent handlers:
 *
 * ```ts
 * const data = (await req.json()) as InvocationData;
 * const invocation = Invocation.fromJSON(data);
 * const run = session.createRun(invocation, { signal: req.signal });
 * await run.start();
 * await run.loadProjection(); // fetch run projection from the channel
 * const messages = run.messages;
 * ```
 *
 * The body carries only what the agent needs out-of-band before the channel
 * is observable: the `runId`, the session/channel name, and the
 * `inputEventId` that triggered the invocation. The agent mints the
 * `invocationId` itself (one per HTTP request) and returns it on the HTTP
 * response, so it is not a body field. Per-message metadata — `clientId`,
 * `parent`, `forkOf`, continuation flag — lives on the channel and is resolved
 * by the agent from the triggering input event, not from the body. The
 * `inputClientId` the agent re-stamps on its own publishes comes from the
 * publisher's Ably `clientId` on the matched input event, not from a body
 * field.
 */

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * Wire shape of a single invocation — the JSON body sent from the client
 * transport's HTTP POST to the agent endpoint.
 */
export interface InvocationData {
  /**
   * Identifier for the run this invocation continues, or `undefined` for a
   * fresh run. The client no longer mints run-ids: a fresh send omits this and
   * the agent mints the run-id itself (mirroring how it mints the
   * `invocationId`). A continuation (tool-resolution, resume) carries the
   * existing run-id the client already knows.
   */
  runId?: string;
  /**
   * Identifier for the specific input event on the channel that triggered
   * this invocation. The agent locates the event via the `event-id`
   * header.
   */
  inputEventId: string;
  /** Logical name of the session (chat) — used as the Ably channel name. */
  sessionName: string;
}

// ---------------------------------------------------------------------------
// Runtime view
// ---------------------------------------------------------------------------

/**
 * Runtime view of an {@link InvocationData}. Constructed via
 * {@link Invocation.fromJSON}. Read-only; carries no behaviour beyond
 * exposing its fields.
 */
// Spec: AIT-ST13
export class Invocation {
  /** Identifier for the run this invocation continues, or `undefined` for a fresh run (the agent mints it). */
  readonly runId: string | undefined;
  /**
   * Identifier for the specific input event on the channel that triggered
   * this invocation.
   */
  readonly inputEventId: string;
  /** Logical name of the session (chat). Used as the Ably channel name. */
  readonly sessionName: string;

  private constructor(data: InvocationData) {
    this.runId = data.runId;
    this.inputEventId = data.inputEventId;
    this.sessionName = data.sessionName;
  }

  /**
   * Build an Invocation from its JSON wire shape.
   * @param data - Parsed JSON body matching {@link InvocationData}.
   * @returns A new Invocation exposing the same fields.
   */
  static fromJSON(data: InvocationData): Invocation {
    return new Invocation(data);
  }

  /**
   * Serialise this invocation to its JSON wire shape — the body a client
   * POSTs to the agent's endpoint to wake a run. Round-trips through
   * {@link Invocation.fromJSON}.
   * @returns The {@link InvocationData} carrying this invocation's identity.
   */
  toJSON(): InvocationData {
    return {
      // Omit runId for a fresh run — the agent mints it. Continuations carry it.
      ...(this.runId !== undefined && { runId: this.runId }),
      inputEventId: this.inputEventId,
      sessionName: this.sessionName,
    };
  }
}
