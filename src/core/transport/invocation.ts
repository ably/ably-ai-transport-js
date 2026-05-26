/**
 * Invocation — value object wrapping the JSON body that a client sends to
 * an agent's HTTP endpoint to start a run.
 *
 * The data shape is the wire contract; the {@link Invocation} class is a
 * runtime view of that data with the same fields. {@link Invocation.fromJSON}
 * is the entry point used by agent handlers:
 *
 * ```ts
 * const data = (await req.json()) as InvocationData<UIMessage>;
 * const invocation = Invocation.fromJSON(data);
 * const run = session.createRun(invocation, { signal: req.signal });
 * ```
 *
 * The body carries only what the agent needs out-of-band before the channel
 * is observable: identifiers (`runId`, `invocationId`), the session/channel
 * name, the prior-conversation context (`history`), and the wait-set
 * (`eventIds`). Per-message metadata — `clientId`, `parent`, `forkOf`,
 * continuation flag — lives on the channel as `x-ably-*` headers and is
 * resolved by the agent from the prompt-lookup result, not from the body.
 */

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * Wire shape of a single invocation — the JSON body sent from the client
 * transport's HTTP POST to the agent endpoint.
 * @template TMessage - Codec domain message type for history entries.
 */
export interface InvocationData<TMessage> {
  /** Identifier for the run this invocation creates. */
  runId: string;
  /** Identifier for this specific invocation under the run. The agent correlates client-published events on the channel by this id. */
  invocationId: string;
  /** Logical name of the session (chat) — typically used as the Ably channel name. */
  sessionName: string;
  /**
   * Prior conversation along the selected branch, already projection-folded
   * into the codec's TMessage shape. The agent feeds these straight to the
   * model. Empty / omitted when there is no prior context (root run).
   */
  history?: TMessage[];
  /**
   * Per-event ids the agent should observe on the channel before starting
   * LLM work — one entry per client-published event in the send (user-message
   * AND continuation tool-resolution publishes). Matched against
   * `x-ably-event-id` on inbound messages. Empty / omitted when the send
   * carries no prompt-bearing events.
   */
  eventIds?: string[];
}

// ---------------------------------------------------------------------------
// Runtime view
// ---------------------------------------------------------------------------

/**
 * Runtime view of an {@link InvocationData}. Constructed via
 * {@link Invocation.fromJSON}. Read-only; carries no behaviour beyond
 * exposing its fields.
 * @template TMessage - Codec domain message type for history entries.
 */
// Spec: AIT-ST13
export class Invocation<TMessage> {
  /** Identifier for the run this invocation creates. */
  readonly runId: string;
  /** Identifier for this specific invocation under the run. */
  readonly invocationId: string;
  /** Logical name of the session (chat). */
  readonly sessionName: string;
  /** Prior conversation history. Empty array when none supplied. */
  readonly history: TMessage[];
  /**
   * Per-event ids — one entry per client-published event in the send. The
   * agent waits for every listed id to appear on the channel (matched via
   * `x-ably-event-id`) before letting the run begin LLM work.
   */
  readonly eventIds: string[];

  private constructor(data: InvocationData<TMessage>) {
    this.runId = data.runId;
    this.invocationId = data.invocationId;
    this.sessionName = data.sessionName;
    this.history = data.history ?? [];
    this.eventIds = data.eventIds ?? [];
  }

  /**
   * Build an Invocation from its JSON wire shape.
   * @param data - Parsed JSON body matching {@link InvocationData}.
   * @returns A new Invocation exposing the same fields.
   */
  static fromJSON<TMessage>(data: InvocationData<TMessage>): Invocation<TMessage> {
    return new Invocation(data);
  }
}
