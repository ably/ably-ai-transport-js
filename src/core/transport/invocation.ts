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
 * const invocation = Invocation.fromJSON(data); // mints invocationId if absent
 * const run = session.createRun(invocation, { signal: req.signal });
 * await run.start();
 * await run.loadProjection(); // fetch run projection from the channel
 * const messages = run.messages;
 * // Return the (possibly minted) invocation id so the caller can correlate.
 * return Response.json({ invocationId: invocation.invocationId });
 * ```
 *
 * The body carries only what the agent needs out-of-band before the channel
 * is observable: the `inputEventId` that triggered the invocation and the
 * session/channel name. Run and invocation identity is the agent's to mint:
 * a fresh-run body omits `runId` (the agent mints the run id) and may omit
 * `invocationId` (the agent's POST handler mints it); a continuation body
 * carries the `runId` the client already knows. A supplied id is honoured —
 * the {@link Invocation} mints only what the body left out. Per-message
 * metadata — `clientId`, `parent`, `forkOf`, continuation flag — lives on the
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
   * Identifier for the run this invocation continues. Omitted on a fresh-run
   * body — the agent mints the run id. Present only for a continuation, where
   * the client already knows the active run.
   */
  runId?: string;
  /**
   * Identifier for this specific invocation under the run. May be omitted —
   * the agent's POST handler mints it. The agent correlates client-published
   * events on the channel by this id.
   */
  invocationId?: string;
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
 * {@link Invocation.fromJSON}. Read-only. The only behaviour is identity
 * minting: `invocationId` is minted when the source body omitted it, so the
 * agent always has a stable invocation id to correlate channel events by.
 */
// Spec: AIT-ST13
export class Invocation {
  /**
   * Identifier for the run this invocation continues, when the body carried
   * one. Undefined for a fresh run — the agent mints the run id at run
   * creation rather than reading it here.
   */
  readonly runId: string | undefined;
  /**
   * Identifier for this specific invocation under the run. Minted here when
   * the source body omitted one.
   */
  readonly invocationId: string;
  /**
   * Identifier for the specific input event on the channel that triggered
   * this invocation.
   */
  readonly inputEventId: string;
  /** Logical name of the session (chat). Used as the Ably channel name. */
  readonly sessionName: string;

  private constructor(data: InvocationData) {
    this.runId = data.runId;
    // Mint the invocation id when the body omitted it — invocation identity
    // is the agent's to own. A supplied id (e.g. a client that still mints)
    // is honoured so this stays compatible with both wire shapes.
    this.invocationId = data.invocationId ?? crypto.randomUUID();
    this.inputEventId = data.inputEventId;
    this.sessionName = data.sessionName;
  }

  /**
   * Build an Invocation from its JSON wire shape, minting an `invocationId`
   * if the body omitted one.
   * @param data - Parsed JSON body matching {@link InvocationData}.
   * @returns A new Invocation, with `invocationId` guaranteed populated.
   */
  static fromJSON(data: InvocationData): Invocation {
    return new Invocation(data);
  }

  /**
   * Serialise this invocation to its JSON wire shape — the body a client
   * POSTs to the agent's endpoint to wake a run. `runId` is omitted when this
   * invocation carries none (a fresh run).
   * @returns The {@link InvocationData} carrying this invocation's identity.
   */
  toJSON(): InvocationData {
    return {
      invocationId: this.invocationId,
      inputEventId: this.inputEventId,
      sessionName: this.sessionName,
      ...(this.runId !== undefined && { runId: this.runId }),
    };
  }
}
