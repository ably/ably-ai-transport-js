import type * as Ably from 'ably';

import type { Logger } from '../../src/logger.js';
import type { AnyCodec, CodecMessage } from './codec.js';
import type { Invocation } from './invocation.js';
import type { AgentRun, ClientRun } from './run.js';
import type { StorageReader, StorageWriter } from './storage.js';
import type { Tree } from './tree.js';
import type { AgentView, ClientView, CreateViewOptions } from './view.js';
import type { SessionWriter } from './writer.js';

/**
 * Options shared by {@link createClientSession} and {@link createAgentSession}.
 *
 * Parameterised by the codec — `C extends Codec<TPart, TMessage, TEvent>` —
 * so callers name the session variant with a single type argument. The
 * factory functions infer `C` from `options.codec`, so call sites rarely
 * need to write it explicitly.
 */
export interface SessionOptions<C extends AnyCodec> {
  /**
   * The Ably Realtime client. The SDK derives the channel(s) it needs from
   * the session name. Taking a client (rather than a pre-constructed channel)
   * lets the SDK tag it with an `ably-agent` header for usage attribution and
   * leaves room to evolve a session into multiple channels in future without
   * a breaking change.
   */
  client: Ably.Realtime;

  /**
   * The session name. Matches {@link InvocationData.sessionName} so the value
   * that names the session on both ends of an HTTP hop is identically typed.
   * Today this is used as the name of the single channel backing the session;
   * in future a session may span multiple channels and the SDK will derive
   * those channel names from this value.
   */
  sessionName: string;

  /** Codec that translates between domain parts and channel operations. */
  codec: C;

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
export interface ClientSession<C extends AnyCodec> {
  /** The session name, as passed to createClientSession. */
  readonly sessionName: string;

  /** The unfiltered conversation tree. Available before connect(). */
  readonly tree: Tree<CodecMessage<C>, ClientRun<C>>;

  /**
   * Create a projected view over the tree. Each view has independent branch
   * selection and pagination. Views can be created before connect() — the
   * view pends hydration and fills in as the session materialises the channel.
   * Call view.close() to release a view when it's no longer needed.
   */
  createView(options?: CreateViewOptions): ClientView<C>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   *
   * Idempotent: calling connect() a second time is a no-op and resolves
   * immediately so that workflow retries are not hostile.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the tree and all views.
   * Idempotent and never rejects — callers can safely call close() in
   * error-handling paths without wrapping it in try/catch.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to {@link close}. Closes subscriptions
   * and releases views; no publish side effects.
   */
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
   * internally. Exposed at the top level (not demoted behind an `.advanced`
   * namespace) so server-side validation handlers and orchestrators can
   * reach it directly.
   *
   * A session created without calling {@link connect} can be used
   * writer-only — the writer publishes directly to the channel without
   * hydrating the tree or subscribing. This is the "lifecycle-only"
   * durable-execution pattern (see plan §5.7).
   */
  readonly writer: SessionWriter<C>;
}

/**
 * Long-lived handle on a durable session from the agent's perspective.
 * Primary reads happen through an {@link AgentView} scoped to an
 * {@link Invocation}; the tree is available as an escape hatch and the
 * writer is exposed for orchestration patterns.
 */
export interface AgentSession<C extends AnyCodec> {
  /** The session name, as passed to createAgentSession. */
  readonly sessionName: string;

  /**
   * The unfiltered conversation tree. Available as an escape hatch for
   * advanced cases. Most agents read the conversation through the step.
   */
  readonly tree: Tree<CodecMessage<C>, AgentRun<CodecMessage<C>>>;

  /**
   * Create a view scoped to the run an invocation names. The view's branch
   * selection is pinned by the invocation's run ID — it shows the linear
   * conversation the run sits on (ancestry from root plus the run's own
   * messages). Views can be created before connect() — the view pends
   * hydration and fills in as the session materialises the channel. Call
   * view.createStep() to produce the step that executes the run.
   */
  createView(invocation: Invocation): AgentView<C>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   *
   * Idempotent: calling connect() a second time is a no-op and resolves
   * immediately so that workflow retries are not hostile.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the session.
   * Idempotent and never rejects — callers can safely call close() in
   * error-handling paths without wrapping it in try/catch.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to {@link close}. Closes subscriptions
   * and releases views; no publish side effects.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach, failed state, or storage reader/writer failure.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  /** Remove a previously registered `error` handler. */
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;

  /**
   * Low-level write surface. Steps delegate to this internally. Exposed at
   * the top level for orchestrators and advanced patterns (e.g. subagent
   * fan-out, lifecycle-only hops).
   *
   * A session created without calling {@link connect} can be used
   * writer-only — the writer publishes directly to the channel without
   * hydrating the tree or subscribing. This is the "lifecycle-only"
   * durable-execution pattern (see plan §5.7).
   */
  readonly writer: SessionWriter<C>;
}

/**
 * Create a new {@link ClientSession}. The returned session is not yet live —
 * register listeners, then call connect() to subscribe to the channel and
 * hydrate from storage.
 *
 * `C` is inferred from `options.codec`, so call sites don't need to write
 * it explicitly:
 *
 * ```ts
 * const session = createClientSession({ client, sessionName, codec });
 * //     ^? ClientSession<typeof codec>
 * ```
 *
 * @param options - Shared {@link SessionOptions} wiring client, session name, codec, and optional storage.
 * @returns A not-yet-connected {@link ClientSession}.
 */
export declare function createClientSession<C extends AnyCodec>(options: SessionOptions<C>): ClientSession<C>;

/**
 * Create a new {@link AgentSession}. The returned session is not yet live —
 * register listeners, then call connect() to subscribe to the channel and
 * hydrate from storage.
 *
 * `C` is inferred from `options.codec`, so call sites don't need to write
 * it explicitly.
 *
 * @param options - Shared {@link SessionOptions} wiring client, session name, codec, and optional storage.
 * @returns A not-yet-connected {@link AgentSession}.
 */
export declare function createAgentSession<C extends AnyCodec>(options: SessionOptions<C>): AgentSession<C>;
