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
 */

import type { MessageNode } from './types.js';

/**
 * Wire shape of a single invocation — the JSON body sent from the client
 * transport's HTTP POST to the agent endpoint.
 * @template TMessage - Codec domain message type for history nodes.
 */
export interface InvocationData<TMessage> {
  /** Identifier for the run this invocation creates. */
  runId: string;
  /** Identifier for this specific invocation under the run. The agent correlates client-published events on the channel by this id. */
  invocationId: string;
  /** ClientId of the caller — used for attribution and own-cancel routing. */
  clientId: string;
  /** Logical name of the session (chat) — typically used as the Ably channel name. */
  sessionName: string;
  /** Prior conversation history along the selected branch. The agent feeds these to the model. */
  history?: MessageNode<TMessage>[];
  /** msg-id of the message this run's first message parents off (auto-computed by the client when omitted). */
  parent?: string;
  /** msg-id of the message this run forks (regenerate / edit). */
  forkOf?: string;
  /**
   * Per-event ids the agent should observe on the channel before starting
   * LLM work — one entry per client-published event in the send (user-message
   * AND amend events such as tool-approval responses and client tool outputs).
   * Matched against `x-ably-prompt-id` on inbound messages. Empty / omitted
   * for continuations that publish no new prompt-bearing events.
   */
  promptIds?: string[];
  /**
   * Whether this invocation continues an already-started run rather than
   * starting a fresh one. The client sets this when it supplies an existing
   * `runId` (e.g. tool-result follow-up). The agent stamps
   * `x-ably-run-continue: true` on the `run-start` lifecycle event so
   * downstream consumers can distinguish a continuation from a first start.
   */
  isContinuation?: boolean;
}

/**
 * Runtime view of an {@link InvocationData}. Constructed via
 * {@link Invocation.fromJSON}. Read-only; carries no behaviour beyond
 * exposing its fields.
 * @template TMessage - Codec domain message type for history nodes.
 */
// Spec: AIT-ST13
export class Invocation<TMessage> {
  /** Identifier for the run this invocation creates. */
  readonly runId: string;
  /** Identifier for this specific invocation under the run. */
  readonly invocationId: string;
  /** ClientId of the caller. */
  readonly clientId: string;
  /** Logical name of the session (chat). */
  readonly sessionName: string;
  /** msg-id of the parent message (or undefined for a root run). */
  readonly parent: string | undefined;
  /** msg-id of the forked message (regenerate / edit), or undefined. */
  readonly forkOf: string | undefined;
  /** Prior conversation history. Empty array when none supplied. */
  readonly history: MessageNode<TMessage>[];
  /**
   * Per-event ids — one entry per client-published event in the send. The
   * agent waits for every listed id to appear on the channel (matched via
   * `x-ably-prompt-id`) before letting the run begin LLM work.
   */
  readonly promptIds: string[];
  /**
   * Whether this invocation continues an already-started run. Drives the
   * `x-ably-run-continue` header on the published `run-start` event so
   * consumers can distinguish a continuation from a first start.
   */
  readonly isContinuation: boolean;

  private constructor(data: InvocationData<TMessage>) {
    this.runId = data.runId;
    this.invocationId = data.invocationId;
    this.clientId = data.clientId;
    this.sessionName = data.sessionName;
    this.parent = data.parent;
    this.forkOf = data.forkOf;
    this.history = data.history ?? [];
    this.promptIds = data.promptIds ?? [];
    this.isContinuation = data.isContinuation ?? false;
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
