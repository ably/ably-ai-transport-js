/**
 * Invocation — value object wrapping the JSON body that a client sends to
 * an agent's HTTP endpoint to start a run.
 *
 * The data shape is the wire contract; the {@link Invocation} class is a
 * runtime view of that data with the same fields. {@link Invocation.fromJSON}
 * is the entry point used by agent handlers:
 *
 * ```ts
 * const data = (await req.json()) as InvocationData<UIMessageChunk, UIMessage>;
 * const invocation = Invocation.fromJSON(data);
 * const run = session.createRun(invocation, { signal: req.signal });
 * ```
 */

import type { EventsNode, MessageNode } from './types.js';

/**
 * Wire shape of a single invocation — the JSON body sent from the client
 * transport's HTTP POST to the agent endpoint.
 * @template TEvent - Codec event type carried in cross-run amendments.
 * @template TMessage - Codec domain message type for messages and history.
 */
export interface InvocationData<TEvent, TMessage> {
  /** Identifier for the run this invocation creates. */
  runId: string;
  /** Identifier for this specific invocation under the run. The agent correlates the user-prompt message on the channel by this id. */
  invocationId: string;
  /** ClientId of the caller — used for attribution and own-cancel routing. */
  clientId: string;
  /** Logical name of the session (chat) — typically used as the Ably channel name. */
  sessionName: string;
  /** New user messages to publish at the start of the run. Empty array when none supplied (e.g. regenerate). */
  messages?: MessageNode<TMessage>[];
  /** Prior conversation history along the selected branch. The agent feeds these to the model. */
  history?: MessageNode<TMessage>[];
  /** Cross-run amendment events (e.g. tool outputs produced on the client) to apply before streaming. */
  events?: EventsNode<TEvent>[];
  /** msg-id of the message this run's first message parents off (auto-computed by the client when omitted). */
  parent?: string;
  /** msg-id of the message this run forks (regenerate / edit). */
  forkOf?: string;
  /**
   * Number of user messages the client published on the channel for this
   * invocation. Zero indicates a continuation (e.g. `sendAutomaticallyWhen`
   * after a tool result) where the agent should NOT block on a channel
   * prompt lookup — there is no new user prompt to find.
   */
  userMessageCount?: number;
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
 * @template TEvent - Codec event type carried in cross-run amendments.
 * @template TMessage - Codec domain message type for messages and history.
 */
// Spec: AIT-ST13
export class Invocation<TEvent, TMessage> {
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
  /**
   * New user messages for this run. Empty when the client publishes user
   * messages directly on the channel — the agent obtains them via channel
   * rewind keyed by `invocationId`. Populated by legacy callers that thread
   * messages through the invocation body.
   */
  readonly messages: MessageNode<TMessage>[];
  /** Prior conversation history. Empty array when none supplied. */
  readonly history: MessageNode<TMessage>[];
  /** Cross-run amendment events. Empty array when none supplied. */
  readonly events: EventsNode<TEvent>[];
  /**
   * Number of new user messages the client published on the channel for
   * this invocation. Zero for continuations (no new user prompt to look up);
   * positive when the client published one or more user messages and the
   * agent should locate them via channel rewind.
   */
  readonly userMessageCount: number;
  /**
   * Whether this invocation continues an already-started run. Drives the
   * `x-ably-run-continue` header on the published `run-start` event so
   * consumers can distinguish a continuation from a first start.
   */
  readonly isContinuation: boolean;

  private constructor(data: InvocationData<TEvent, TMessage>) {
    this.runId = data.runId;
    this.invocationId = data.invocationId;
    this.clientId = data.clientId;
    this.sessionName = data.sessionName;
    this.parent = data.parent;
    this.forkOf = data.forkOf;
    this.messages = data.messages ?? [];
    this.history = data.history ?? [];
    this.events = data.events ?? [];
    // Default to messages.length so legacy callers that populate
    // `invocation.messages` directly behave correctly without setting the
    // count explicitly.
    this.userMessageCount = data.userMessageCount ?? this.messages.length;
    this.isContinuation = data.isContinuation ?? false;
  }

  /**
   * Build an Invocation from its JSON wire shape.
   * @param data - Parsed JSON body matching {@link InvocationData}.
   * @returns A new Invocation exposing the same fields.
   */
  static fromJSON<TEvent, TMessage>(data: InvocationData<TEvent, TMessage>): Invocation<TEvent, TMessage> {
    return new Invocation(data);
  }
}
