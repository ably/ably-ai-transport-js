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
 * while (run.view.hasOlder()) await run.view.loadOlder(); // page channel history for context
 * await run.start();
 * const messages = run.view.getMessages().map((m) => m.message);
 * ```
 *
 * The body carries only what the agent needs out-of-band before the channel
 * is observable: the session/channel name and the `inputEventId` that triggered
 * the invocation. The agent mints the `invocationId` itself (one per HTTP
 * request) and returns it on the HTTP response, so it is not a body field. Run
 * identity also lives on the channel: the agent mints the `runId` for a fresh
 * run and reads the existing `runId` off the triggering input event for a
 * continuation — so the body carries no run-id either. Per-message metadata —
 * `clientId`, `parent`, `forkOf`, continuation status — likewise lives on the
 * channel and is resolved by the agent from the triggering input event, not
 * from the body. The `inputClientId` the agent re-stamps on its own publishes
 * comes from the publisher's Ably `clientId` on the matched input event, not
 * from a body field.
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
   * Identifier for the specific input event on the channel that triggered
   * this invocation. The agent locates the event via the `event-id`
   * header. Its wire headers carry the run-id for a continuation (absent for
   * a fresh run), so run identity is resolved from the channel, not the body.
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
  /**
   * Identifier for the specific input event on the channel that triggered
   * this invocation. Run identity is resolved from that event's wire headers
   * (or minted), not from the body.
   */
  readonly inputEventId: string;
  /** Logical name of the session (chat). Used as the Ably channel name. */
  readonly sessionName: string;

  private constructor(data: InvocationData) {
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
      inputEventId: this.inputEventId,
      sessionName: this.sessionName,
    };
  }
}
