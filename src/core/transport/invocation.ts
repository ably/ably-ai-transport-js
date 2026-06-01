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
 * is observable: identifiers (`runId`, `invocationId`), the session/channel
 * name, the `eventId` that triggered the invocation. Per-message metadata — `clientId`, `parent`, `forkOf`,
 * continuation flag — lives on the channel and is resolved by the agent from
 * the triggering input event, not from the body. The `inputClientId` the
 * agent re-stamps on its own publishes comes from the publisher's Ably
 * `clientId` on the matched input event, not from a body field.
 */

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * Wire shape of a single invocation — the JSON body sent from the client
 * transport's HTTP POST to the agent endpoint.
 */
export interface InvocationData {
  /** Identifier for the run this invocation creates or continues. */
  runId: string;
  /** Identifier for this specific invocation under the run. The agent correlates client-published events on the channel by this id. */
  invocationId: string;
  /**
   * Identifier for the specific input event on the channel that triggered
   * this invocation. The agent locates the event via the `x-ably-event-id`
   * header.
   */
  eventId: string;
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
  /** Identifier for the run this invocation creates. */
  readonly runId: string;
  /** Identifier for this specific invocation under the run. */
  readonly invocationId: string;
  /**
   * Identifier for the specific input event on the channel that triggered
   * this invocation.
   */
  readonly eventId: string;
  /** Logical name of the session (chat). Used as the Ably channel name. */
  readonly sessionName: string;

  private constructor(data: InvocationData) {
    this.runId = data.runId;
    this.invocationId = data.invocationId;
    this.eventId = data.eventId;
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
}
