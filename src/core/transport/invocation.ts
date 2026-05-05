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
  /** ClientId of the caller — used for attribution and own-cancel routing. */
  clientId: string;
  /** Logical name of the session (chat) — typically used as the Ably channel name. */
  sessionName: string;
  /** New user messages to publish at the start of the run. May be empty (e.g. regenerate). */
  messages: MessageNode<TMessage>[];
  /** Prior conversation history along the selected branch. The agent feeds these to the model. */
  history?: MessageNode<TMessage>[];
  /** Cross-run amendment events (e.g. tool outputs produced on the client) to apply before streaming. */
  events?: EventsNode<TEvent>[];
  /** msg-id of the message this run's first message parents off (auto-computed by the client when omitted). */
  parent?: string;
  /** msg-id of the message this run forks (regenerate / edit). */
  forkOf?: string;
}

/**
 * Runtime view of an {@link InvocationData}. Constructed via
 * {@link Invocation.fromJSON}. Read-only; carries no behaviour beyond
 * exposing its fields.
 * @template TEvent - Codec event type carried in cross-run amendments.
 * @template TMessage - Codec domain message type for messages and history.
 */
export class Invocation<TEvent, TMessage> {
  /** Identifier for the run this invocation creates. */
  readonly runId: string;
  /** ClientId of the caller. */
  readonly clientId: string;
  /** Logical name of the session (chat). */
  readonly sessionName: string;
  /** msg-id of the parent message (or undefined for a root run). */
  readonly parent: string | undefined;
  /** msg-id of the forked message (regenerate / edit), or undefined. */
  readonly forkOf: string | undefined;
  /** New user messages to publish for this run. */
  readonly messages: MessageNode<TMessage>[];
  /** Prior conversation history. Empty array when none supplied. */
  readonly history: MessageNode<TMessage>[];
  /** Cross-run amendment events. Empty array when none supplied. */
  readonly events: EventsNode<TEvent>[];

  private constructor(data: InvocationData<TEvent, TMessage>) {
    this.runId = data.runId;
    this.clientId = data.clientId;
    this.sessionName = data.sessionName;
    this.parent = data.parent;
    this.forkOf = data.forkOf;
    this.messages = data.messages;
    this.history = data.history ?? [];
    this.events = data.events ?? [];
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
