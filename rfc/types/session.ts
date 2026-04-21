import type * as Ably from 'ably';

import type { Logger } from '../../src/logger.js';
import type { Codec } from './codec.js';
import type { Invocation } from './invocation.js';
import type { AgentRun, ClientRun } from './run.js';
import type { StorageReader, StorageWriter } from './storage.js';
import type { Tree } from './tree.js';
import type { AgentView, ClientView, CreateViewOptions } from './view.js';
import type { SessionWriter } from './writer.js';

/** Options shared by {@link createClientSession} and {@link createAgentSession}. */
export interface SessionOptions<TEvent, TMessage> {
  /**
   * The Ably Realtime client. The SDK derives the channel(s) it needs from
   * the session name. Taking a client (rather than a pre-constructed channel)
   * lets the SDK tag it with an `ably-agent` header for usage attribution and
   * leaves room to evolve a session into multiple channels in future without
   * a breaking change.
   */
  client: Ably.Realtime;

  /**
   * The session name. Today this is used as the name of the single channel
   * backing the session; in future a session may span multiple channels and
   * the SDK will derive those channel names from this value.
   */
  name: string;

  /** Codec that translates between domain events and channel operations. */
  codec: Codec<TEvent, TMessage>;

  /** Loads historical state into the session during connect(). Omit for a fresh session. */
  storageReader?: StorageReader;

  /** Receives channel messages as the session processes them, for external persistence. */
  storageWriter?: StorageWriter;

  /** Logger instance. */
  logger?: Logger;
}

/**
 * Long-lived handle on a durable session from the client's perspective.
 * Exposes the unfiltered conversation tree, creates projected views for
 * rendering, and carries the low-level writer for advanced publish
 * patterns (server-side validation, orchestration).
 */
export interface ClientSession<TEvent, TMessage> {
  /** The session name, as passed to createClientSession. */
  readonly name: string;

  /** The unfiltered conversation tree. Available before connect(). */
  readonly tree: Tree<TMessage, ClientRun<TMessage>>;

  /**
   * Create a projected view over the tree. Each view has independent branch
   * selection and pagination. Views can be created before or after connect().
   * Call view.close() to release a view when it's no longer needed.
   */
  createView(options?: CreateViewOptions): ClientView<TMessage>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the tree and all views.
   */
  close(): Promise<void>;

  /** Symbol.asyncDispose — equivalent to close() if the session has not already been closed. */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach, failed state, or storage reader/writer failure.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  /** Remove a previously registered `error` handler. */
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;

  /**
   * Low-level write surface for publishing lifecycle events, messages, and
   * signals directly to the channel. Views and runs delegate to this
   * internally. Exposed for server-side validation handlers, orchestrators,
   * and advanced patterns that need explicit control.
   *
   * Can be used without connect() — publishes directly to the channel.
   */
  readonly writer: SessionWriter<TEvent, TMessage>;
}

/**
 * Long-lived handle on a durable session from the agent's perspective.
 * Primary reads happen through an {@link AgentView} scoped to an
 * {@link Invocation}; the tree is available as an escape hatch and the
 * writer is exposed for orchestration patterns.
 */
export interface AgentSession<TEvent, TMessage> {
  /** The session name, as passed to createAgentSession. */
  readonly name: string;

  /**
   * The unfiltered conversation tree. Available as an escape hatch for
   * advanced cases. Most agents read the conversation through the step.
   */
  readonly tree: Tree<TMessage, AgentRun<TMessage>>;

  /**
   * Create a view scoped to the run an invocation names. The view's branch
   * selection is pinned by the invocation's run ID — it shows the linear
   * conversation the run sits on (ancestry from root plus the run's own
   * messages). Call view.createStep() to produce the step that executes
   * the run.
   */
  createView(invocation: Invocation): AgentView<TEvent, TMessage>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the session.
   */
  close(): Promise<void>;

  /** Symbol.asyncDispose — equivalent to close() if the session has not already been closed. */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach, failed state, or storage reader/writer failure.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  /** Remove a previously registered `error` handler. */
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;

  /**
   * Low-level write surface. Steps delegate to this internally. Exposed for
   * orchestrators and advanced patterns (e.g. subagent fan-out).
   */
  readonly writer: SessionWriter<TEvent, TMessage>;
}

/**
 * Create a new {@link ClientSession}. The returned session is not yet live —
 * register listeners, then call connect() to subscribe to the channel and
 * hydrate from storage.
 * @param options - Shared {@link SessionOptions} wiring client, session name, codec, and optional storage.
 * @returns A not-yet-connected {@link ClientSession}.
 */
export declare function createClientSession<TEvent, TMessage>(
  options: SessionOptions<TEvent, TMessage>,
): ClientSession<TEvent, TMessage>;

/**
 * Create a new {@link AgentSession}. The returned session is not yet live —
 * register listeners, then call connect() to subscribe to the channel and
 * hydrate from storage.
 * @param options - Shared {@link SessionOptions} wiring client, session name, codec, and optional storage.
 * @returns A not-yet-connected {@link AgentSession}.
 */
export declare function createAgentSession<TEvent, TMessage>(
  options: SessionOptions<TEvent, TMessage>,
): AgentSession<TEvent, TMessage>;
