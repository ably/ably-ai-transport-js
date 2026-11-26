/**
 * The AG-UI agent: AG-UI's own `HttpAgent`, with each run read from the
 * thread's Ably channel instead of the HTTP response.
 *
 * `HttpAgent` posts a run's `RunAgentInput` and reads the run's events back
 * from the response, so a run reaches only the tab that sent it, and only
 * while the request is open. This agent posts the same request, and reads the
 * run from the channel the backend pipes it onto with `agUiAdaptor`. It
 * builds no messages: AG-UI's own reducer applies the events to the agent's
 * `messages` and `state`.
 */

import * as Ably from '@ably/pubsub-core';
import * as AGUI from '@ag-ui/client';
import * as Rx from 'rxjs';

import { isRecord } from '../../core/wire.js';
import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage, responseText } from '../../utils.js';
import { ChannelRead } from './channel-read.js';

/**
 * Options for {@link createAblyAgent}: `HttpAgent`'s, and the thread's
 * channel. `url`, `headers` and `fetch` make the request `runAgent()` posts,
 * and `threadId`, `initialMessages` and `initialState` set up the agent, as
 * they do for `HttpAgent`.
 */
export interface AblyAgentOptions extends AGUI.HttpAgentConfig {
  /**
   * The thread's channel, from the application's Pub/Sub client: the channel
   * the backend pipes the thread's runs onto with `agUiAdaptor`. The agent
   * reads every run from it, so create an agent for each thread. A run the
   * backend publishes on another channel, as for a `threadId` changed to
   * another thread's, never ends in this tab.
   *
   * Each run reads the channel through a listener of its own, attaching the
   * channel first if it isn't attached, and removes the listener when it
   * ends. The channel stays attached after the run: detach it when the
   * application is done with the thread, such as when the tab stops showing
   * it.
   */
  channel: Ably.RealtimeChannel;
  /** Logger for diagnostics, such as a run whose request failed. Silent when omitted. */
  logger?: Logger;
}

/**
 * The text of the `RUN_ERROR` a run ends with when its request is aborted:
 * `HttpAgent`'s own, for an abort without a message.
 */
const ABORTED_MESSAGE = 'Request aborted';

/**
 * An event's type as the plain string the codec's rows are keyed by. The
 * events come from the codec, which reads `@ag-ui/core`'s types, while this
 * entry point loads AG-UI's values from `@ag-ui/client`, so the agent
 * compares strings rather than `EventType` members.
 * @param event - The event.
 * @returns Its type.
 */
const typeOf = (event: AGUI.Event): `${AGUI.Event['type']}` => event.type;

/**
 * The run an event opens.
 * @param event - The event.
 * @returns The `runId` of a `RUN_STARTED`, or `undefined` for any other event.
 */
const runIdOf = (event: AGUI.Event): string | undefined =>
  typeOf(event) === 'RUN_STARTED' && 'runId' in event ? event.runId : undefined;

/**
 * Whether an event ends a run.
 * @param event - The event.
 * @returns True for `RUN_FINISHED` and `RUN_ERROR`.
 */
const isRunEnd = (event: AGUI.Event): boolean => {
  const type = typeOf(event);
  return type === 'RUN_FINISHED' || type === 'RUN_ERROR';
};

/**
 * What one run hands AG-UI: the channel's events from the run's
 * `RUN_STARTED` to its end, and how the reading ends. It ends once.
 */
class RunStream {
  private readonly _subscriber: Rx.Subscriber<AGUI.BaseEvent>;
  private readonly _logger: Logger;
  /** The run's `runId`, whose `RUN_STARTED` begins the run. */
  private readonly _runId: string;
  private _inRun = false;
  private _settled = false;

  /**
   * @param subscriber - AG-UI's subscription to the run's events.
   * @param logger - The run's logger.
   * @param runId - The run's `runId`.
   */
  constructor(subscriber: Rx.Subscriber<AGUI.BaseEvent>, logger: Logger, runId: string) {
    this._subscriber = subscriber;
    this._logger = logger.withContext({ component: 'RunStream' });
    this._runId = runId;
  }

  /**
   * Whether the events handed on so far stand inside the run.
   * @returns True from the run's `RUN_STARTED` until its end.
   */
  get inRun(): boolean {
    return this._inRun;
  }

  /**
   * Whether the stream has ended.
   * @returns True once it ended, however it ended.
   */
  get settled(): boolean {
    return this._settled;
  }

  /**
   * Hand AG-UI an event that arrived, and end at the run's end. Before the
   * run only the `RUN_STARTED` that carries its `runId` is taken, which
   * begins the run: the events before it are another run's, such as a stopped
   * run still ending. A `RUN_STARTED` inside the run ends the stream with no
   * end event: the backend runs one run at a time, so the run's backend
   * stopped without ending it, and its end will never come.
   * @param event - The event.
   */
  follow(event: AGUI.Event): void {
    if (this._settled) return;
    const startedRun = runIdOf(event);
    if (!this._inRun) {
      if (startedRun !== this._runId) return;
      this._logger.debug('RunStream.follow(); the run started');
      this._inRun = true;
      this._subscriber.next(event);
      return;
    }
    if (startedRun !== undefined) {
      this._logger.warn('RunStream.follow(); another run started before this one ended', { other: startedRun });
      this.end();
      return;
    }
    this._subscriber.next(event);
    if (isRunEnd(event)) {
      this._logger.debug('RunStream.follow(); the run ended', { type: event.type });
      this.end();
    }
  }

  /**
   * End the stream: AG-UI's run completes, or fails with `error`. Ignored
   * once the stream has ended.
   * @param error - The failure, if any.
   */
  end(error?: Ably.ErrorInfo): void {
    if (this._settled) return;
    this._settled = true;
    if (error === undefined) this._subscriber.complete();
    else this._subscriber.error(error);
  }

  /**
   * End the stream in this tab as `HttpAgent` ends an aborted response: with
   * `RUN_ERROR` and the code `abort`. The stream is open only before the
   * run's `RUN_STARTED` or inside the run, where AG-UI takes a `RUN_ERROR`.
   * Ignored once the stream has ended.
   */
  stopInTab(): void {
    if (this._settled) return;
    const stopped: AGUI.RunErrorEvent = { type: AGUI.EventType.RUN_ERROR, message: ABORTED_MESSAGE, code: 'abort' };
    this._subscriber.next(stopped);
    this.end();
  }
}

/**
 * AG-UI's check of a run's outgoing input, with the agent's own limit on the
 * entries it walks, as `HttpAgent` calls it. AG-UI 1.0.4 added the limit as
 * the check's second argument; an earlier check takes one argument and
 * ignores a second.
 */
const enforceOutgoingInput: (input: AGUI.RunAgentInput, options: { maxEntries?: number }) => AGUI.RunAgentInput =
  AGUI.enforceOutgoingInput;

/**
 * The agent's own limit on the entries AG-UI's input check walks, which AG-UI
 * 1.0.4 added as `maxEnforcedEntries`. An agent of an earlier release has
 * none.
 * @param agent - The agent.
 * @returns The limit, or `undefined` for AG-UI's default.
 */
const maxEntriesOf = (agent: AGUI.HttpAgent): number | undefined => {
  const limit: unknown = Reflect.get(agent, 'maxEnforcedEntries');
  return typeof limit === 'number' ? limit : undefined;
};

class AblyAgent extends AGUI.HttpAgent {
  // Set in the constructor and again in clone(): AbstractAgent.clone() builds
  // the copy with Object.create, so no constructor or field initialiser runs
  // on it.
  private _channel: Ably.RealtimeChannel;
  private _logger: Logger;

  constructor(options: AblyAgentOptions) {
    super(options);
    this._channel = options.channel;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'AblyAgent',
    });
  }

  clone(): AGUI.HttpAgent {
    // CAST: HttpAgent.clone() copies through AbstractAgent.clone(), which
    // builds the copy from this agent's own prototype.
    const cloned = super.clone() as AblyAgent;
    cloned._channel = this._channel;
    cloned._logger = this._logger;
    return cloned;
  }

  /**
   * `runAgent()`'s source of events: post the input as `HttpAgent` does once
   * the thread's channel is attached, and read the run from the channel, from
   * its `RUN_STARTED` to its end. An aborted request, as from `abortRun()`,
   * ends the run in this tab.
   * @param input - The run's input, as AG-UI prepared it.
   * @returns The run's events.
   */
  run(input: AGUI.RunAgentInput): Rx.Observable<AGUI.BaseEvent> {
    return new Rx.Observable<AGUI.BaseEvent>((subscriber) => {
      const { threadId, runId } = input;
      const logger = this._logger.withContext({ threadId, runId });
      logger.trace('AblyAgent.run();');
      // HttpAgent's runAgent() gives each run's request a controller of its
      // own, which requestInit() reads and abortRun() aborts.
      const request = this.abortController;
      // Built now, as HttpAgent.run() builds it, so it carries this run's
      // abort signal. A throw here fails the run.
      const init = this._requestInit(input, logger);
      const stream = new RunStream(subscriber, logger, runId);
      if (request.signal.aborted) {
        // Its request was aborted before the run started, as through the
        // caller's own abortController: it ends at once, and reads nothing.
        logger.debug('AblyAgent.run(); the request was aborted before the run started');
        stream.stopInTab();
        return;
      }
      let posted = false;
      const post = (): void => {
        if (posted) return;
        posted = true;
        // Not awaited: a backend that runs its agent inside the request holds
        // it open for the whole run. A failure ends the run through `stream`.
        void this._post(init, stream, logger);
      };
      const read = new ChannelRead({
        channel: this._channel,
        logger,
        onAttached: post,
        onEvent: (event) => {
          stream.follow(event);
        },
        onUndecodable: (error) => {
          if (stream.inRun) stream.end(error);
        },
        onEnd: (error) => {
          stream.end(error);
        },
      });
      const onAbort = (): void => {
        logger.debug('AblyAgent.run(); the request was aborted, so the run ends in this tab');
        stream.stopInTab();
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      return () => {
        request.signal.removeEventListener('abort', onAbort);
        // AG-UI stopped reading before the channel attached, as on
        // detachActiveRun(). The run still goes out, as HttpAgent's request
        // already has by then.
        if (!posted && !stream.settled) {
          logger.debug('AblyAgent.run(); posting a run the tab stopped reading before it attached');
          post();
        }
        read.release();
      };
    });
  }

  /**
   * The request a run posts, as `HttpAgent` builds it: AG-UI's check of the
   * outgoing input, with the agent's own limit on entries, then
   * `requestInit()`, with this agent's headers and abort signal.
   * @param input - The run's input.
   * @param logger - The run's logger.
   * @returns The request.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when AG-UI refuses the input, or it cannot be made into a request.
   */
  private _requestInit(input: AGUI.RunAgentInput, logger: Logger): RequestInit {
    try {
      return this.requestInit(enforceOutgoingInput(input, { maxEntries: maxEntriesOf(this) }));
    } catch (error) {
      const failure = new Ably.ErrorInfo(
        `unable to run the agent; ${errorMessage(error)}`,
        ErrorCode.InvalidArgument,
        400,
        errorCause(error),
      );
      logger.error('AblyAgent.run(); unable to build the request', { error: failure.message });
      throw failure;
    }
  }

  /**
   * Post a run's request, and read the response to its end without using
   * it: closing it early would look like the tab leaving, and stop an agent
   * that runs inside the request. A request that gets no response, or an
   * answer outside 2xx, fails the run, unless it has already ended in this
   * tab. Once the backend has accepted the run the channel carries it, so a
   * response body that breaks later is only logged.
   * @param init - The request.
   * @param stream - The run.
   * @param logger - The run's logger.
   */
  private async _post(init: RequestInit, stream: RunStream, logger: Logger): Promise<void> {
    let response: Response;
    try {
      response = await this.fetch(this.url, init);
    } catch (error) {
      if (init.signal?.aborted === true) {
        logger.debug('AblyAgent.run(); the request was aborted before it was answered');
        return;
      }
      const failure = new Ably.ErrorInfo(
        `unable to run the agent; ${errorMessage(error)}`,
        ErrorCode.SessionSendFailed,
        500,
        errorCause(error),
      );
      this._failRun(failure, stream, logger, { error: failure.message });
      return;
    }
    if (!response.ok) {
      const failure = new Ably.ErrorInfo(
        `unable to run the agent; ${this.url} answered ${String(response.status)}: ${await responseText(response)}`,
        ErrorCode.SessionSendFailed,
        response.status,
      );
      // A response's body can echo the conversation, so the log carries only its status.
      this._failRun(failure, stream, logger, { status: response.status });
      return;
    }
    logger.debug('AblyAgent.run(); the backend accepted the run', { status: response.status });
    try {
      await response.body?.pipeTo(new WritableStream());
    } catch (error) {
      if (init.signal?.aborted === true) return;
      logger.warn('AblyAgent.run(); the response broke after the backend accepted the run', {
        error: errorMessage(error),
      });
    }
  }

  /**
   * Fail a run whose request failed, unless the run has already ended in this
   * tab.
   * @param failure - The error.
   * @param stream - The run.
   * @param logger - The run's logger.
   * @param detail - What the log says about the failure.
   */
  private _failRun(failure: Ably.ErrorInfo, stream: RunStream, logger: Logger, detail: Record<string, unknown>): void {
    if (stream.settled) {
      logger.warn('AblyAgent.run(); the request failed after the run ended in this tab', detail);
      return;
    }
    logger.error('AblyAgent.run(); the request failed', detail);
    stream.end(failure);
  }
}

/**
 * Create an AG-UI agent whose runs arrive over the thread's Ably channel.
 *
 * It returns AG-UI's own `HttpAgent` type, so it works wherever an
 * `HttpAgent` does, and AG-UI's own reducer builds its `messages` and
 * `state`.
 *
 * `runAgent()` attaches the thread's channel if it isn't attached, then posts
 * the run's `RunAgentInput` to `url` as `HttpAgent` does, with its `headers`
 * and `fetch`. It reads the run from the channel rather than from the
 * response: from the `RUN_STARTED` whose `runId` is the input's to that run's
 * `RUN_FINISHED` or `RUN_ERROR`, passing over everything else. Attaching
 * first means the run's first event can't be missed however fast the backend
 * publishes it. The agent reads the response to its end without using it, so
 * the request stays open as long as the backend holds it. The channel stays
 * attached after the run, until the application detaches it.
 *
 * The backend pipes the run's AG-UI events onto the channel with
 * `agUiAdaptor`. It can answer at once and run its agent past the response,
 * or hold the response open for the whole run. Nothing on the wire beyond
 * AG-UI's events says which run an event belongs to, so the backend:
 *
 * - publishes a thread's runs one at a time: a run's `RUN_STARTED` goes out
 *   only after the previous run's `RUN_FINISHED` or `RUN_ERROR`;
 * - publishes `RUN_STARTED` with the input's `runId`, by which the agent
 *   finds its run;
 * - ends every run with `RUN_FINISHED` or `RUN_ERROR`. A run with no end
 *   never ends in a tab that reads it;
 * - refuses an input it can't run with a status outside 2xx, since a
 *   `RUN_ERROR` published before the run's `RUN_STARTED` reaches no tab.
 *
 * A run fails, and `runAgent()` rejects:
 *
 * - with `SessionSendFailed` when its request gets no response, with the
 *   `statusCode` 500, or an answer outside 2xx, with that answer's status;
 * - with `SessionContinuityNotGuaranteed` when the channel becomes FAILED or
 *   SUSPENDED, or attaches again without resuming, while the run is read,
 *   since the run may have missed events;
 * - with the failure's own code when the channel refuses the attach, or is
 *   FAILED, which ably-js subscribes on only once the application has
 *   attached it again;
 * - with `SessionMessageProcessingFailed` when a message of the run cannot
 *   be decoded;
 * - with `InvalidArgument` when AG-UI refuses the input.
 *
 * A run ends with no end event, as `HttpAgent`'s run ends when its response
 * closes early, when another run's `RUN_STARTED` comes before its end, since
 * the backend runs one run at a time and so this run's backend stopped
 * without ending it; and when the channel becomes DETACHED, as it does when
 * the page closes its Ably client.
 *
 * `abortRun()` aborts the request of the run sent last, as `HttpAgent`'s
 * does, and so does aborting the `abortController` given to `runAgent()`. The
 * run then ends in this tab with `RUN_ERROR` and the code `abort`. That
 * reaches the request and this tab only, so an agent that runs past the
 * request goes on, and other tabs read on to the run's end.
 * `detachActiveRun()` stops reading the run; a run it stops before the
 * channel attached is still posted, as `HttpAgent`'s request already is by
 * then.
 *
 * `connectAgent()` is `HttpAgent`'s: it reads nothing, and leaves the agent's
 * `messages` and `state` as they are.
 * @param options - See {@link AblyAgentOptions}.
 * @returns The agent.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `channel` is not a channel.
 */
export const createAblyAgent = (options: AblyAgentOptions): AGUI.HttpAgent => {
  const { channel }: { channel: unknown } = options;
  if (!isRecord(channel) || typeof channel.subscribe !== 'function') {
    throw new Ably.ErrorInfo(
      "unable to create the agent; channel must be the thread's Ably channel",
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return new AblyAgent(options);
};
