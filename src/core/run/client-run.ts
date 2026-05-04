import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { Invocation } from '../invocation/index.js';
import { Invocation as InvocationCtor } from '../invocation/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { Tree } from '../tree/index.js';
import type { Run, RunStatus } from './run.js';

/**
 * Run as seen from a {@link ClientSession}. Adds `toInvocation` and the
 * `abort` control method on top of the base {@link Run<TMessage>}.
 *
 * Returned by {@link ClientView.send}; the caller either calls
 * `run.toInvocation()` to produce a wake-up payload to POST to an agent,
 * or `run.abort()` to publish a durable abort control signal.
 */
export interface ClientRun<C extends AnyCodec> extends Run<CodecMessage<C>> {
  /**
   * Snapshot the run's current state into an {@link Invocation} the caller
   * can serialise and POST to an agent endpoint. Carries the session name,
   * this run's ID, and (when present) the message ID of the message that
   * opened the run, so the agent can wait for that message to be visible
   * before starting its step.
   * @returns A new {@link Invocation} bound to this run's preconditions.
   */
  toInvocation(): Invocation;

  /**
   * Abort this run by publishing an `x-ably-abort` control signal. The
   * signal is itself the run terminal — once it lands, every observer
   * sees `status === 'aborted'` (the tree synthesises it) without waiting
   * for a follow-up `x-ably-run-end`. When an agent is processing the
   * run, the agent's `step.signal` fires; whether that interrupts the
   * stream depends on whether the developer wired `step.signal` into
   * their model SDK. Either way, the agent's `run.end()` publishes
   * `run-end (aborted)` as a confirmation.
   *
   * Returns the run's invocation so the caller can POST it to wake an
   * offline agent. The agent's `createRun` will reject with
   * `RunAborted` (HTTP 410) — the wake-up just confirms the wire state
   * to any agent that didn't already observe the abort. POSTing is
   * optional; when an agent is already alive on the channel, the
   * subscription delivers the abort directly.
   *
   * No-op on terminal runs (`'aborted' | 'complete' | 'failed'`) —
   * multi-device idempotence. The tree synthesises `'aborted'` from
   * `abortRequested` so the second call from a different client (which
   * has already observed the first client's abort via the channel
   * subscription) returns without publishing. The returned `Invocation`
   * is valid regardless of the no-op path.
   *
   * Spec: AIT-AB3.
   * @returns The run's `Invocation` for the caller to POST.
   */
  abort(): Promise<Invocation>;
}

/** Options for {@link createClientRun}. */
export interface ClientRunOptions<C extends AnyCodec> {
  /** The run's unique ID. */
  id: string;
  /** Initial run status — `view.send` always opens runs as `'active'`. */
  status: RunStatus;
  /** The clientId of the participant that opened the run. */
  initiatorClientId: string;
  /** The session this run belongs to; written into produced invocations. */
  sessionName: string;
  /**
   * The message ID published alongside `x-ably-run-start`. When present, an
   * agent receiving the produced {@link Invocation} can wait for this
   * message to be visible on the channel before starting its step.
   */
  messageId?: string;
  /** Tree the handle reads run state from for status and idempotence. */
  tree: Tree<CodecMessage<C>>;
  /** Writer used to publish `x-ably-abort` from {@link ClientRun.abort}. */
  writer: DefaultSessionWriter<C>;
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Default {@link ClientRun} implementation. Lazy-reads run state from the
 * tree on each getter access (so `status` reflects the synthesis from
 * `abortRequested`) and publishes through the session's writer on
 * `abort()`. The instance is constructed by {@link DefaultClientView.send}
 * after a successful run-start; it lives for as long as the calling code
 * holds the reference.
 * @internal
 */
class DefaultClientRun<C extends AnyCodec> implements ClientRun<C> {
  private readonly _id: string;
  private readonly _initialStatus: RunStatus;
  private readonly _initiatorClientId: string;
  private readonly _sessionName: string;
  private readonly _messageId?: string;
  private readonly _tree: Tree<CodecMessage<C>>;
  private readonly _writer: DefaultSessionWriter<C>;
  private readonly _logger: Logger;

  constructor(options: ClientRunOptions<C>) {
    this._id = options.id;
    this._initialStatus = options.status;
    this._initiatorClientId = options.initiatorClientId;
    this._sessionName = options.sessionName;
    this._messageId = options.messageId;
    this._tree = options.tree;
    this._writer = options.writer;
    this._logger = options.logger.withContext({ component: 'ClientRun', runId: options.id });
    this._logger.trace('DefaultClientRun(); initialized');
  }

  get id(): string {
    return this._id;
  }

  get status(): RunStatus {
    // Read from the tree so the synthesised 'aborted' (from abortRequested)
    // surfaces here without a separate code path. Falls back to the
    // initial status when the run-start hasn't echoed back through the
    // decode loop yet.
    return this._tree.runs.find((r) => r.id === this._id)?.status ?? this._initialStatus;
  }

  get abortRequested(): boolean {
    return this._tree.runs.find((r) => r.id === this._id)?.abortRequested === true;
  }

  get initiatorClientId(): string {
    return this._initiatorClientId;
  }

  toInvocation(): Invocation {
    return InvocationCtor.fromJSON({
      sessionName: this._sessionName,
      runId: this._id,
      ...(this._messageId === undefined ? {} : { messageId: this._messageId }),
    });
  }

  async abort(): Promise<Invocation> {
    this._logger.trace('DefaultClientRun.abort();');
    const status = this.status;
    if (status === 'aborted' || status === 'complete' || status === 'failed') {
      this._logger.debug('DefaultClientRun.abort(); run is terminal — no publish', {
        runId: this._id,
        status,
      });
      return this.toInvocation();
    }
    await this._writer.abort({ runId: this._id });
    return this.toInvocation();
  }
}

/**
 * Build a {@link ClientRun} handle. Returned by
 * {@link ClientView.send}; lazy-reads from the tree so multi-device
 * status (and tree-synthesised `'aborted'`) is reflected on every access.
 * @param options The run's identity, session binding, tree, and writer.
 * @returns A {@link ClientRun} bound to the supplied tree and writer.
 */
export const createClientRun = <C extends AnyCodec>(options: ClientRunOptions<C>): ClientRun<C> =>
  new DefaultClientRun<C>(options);
