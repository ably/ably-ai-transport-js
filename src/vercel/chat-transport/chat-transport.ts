/**
 * The useChat transport: a Vercel AI SDK `ChatTransport` whose replies arrive
 * over an Ably channel.
 *
 * `useChat` assumes one HTTP request carries a whole turn: the prompt goes up
 * in the request and the reply comes back down the response. This transport
 * splits the two. It posts the turn to the application's backend as `useChat`
 * describes it, and hands `useChat` the agent's chunks as they arrive on the
 * conversation's channel. The reply therefore outlives the request: a tab that
 * reloads, or opens late, rejoins it from the channel.
 *
 * The transport builds no messages and publishes nothing. `useChat`'s own
 * reducer builds the messages from the chunks.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
// A named import for the one SDK type in a heritage clause: `import-x/namespace`
// cannot verify a namespaced generic in `extends`, though tsc resolves it.
import type { ChatTransport } from 'ai';

import { resolveChannel } from '../../core/transport/transport.js';
import { isRecord } from '../../core/wire.js';
import { ErrorCode, errorInfoIs } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import { vercel } from '../codec/index.js';
import { ABORTED, CLOSED, LOST_CONTINUITY, stoppedError } from './stopped.js';
import { type LatestTurn, TurnReader } from './turn-reader.js';
import { TurnStream } from './turn-stream.js';

/**
 * What {@link ChatTransportOptions.onStop} is called with.
 */
export interface StopContext {
  /** The chat's id: `useChat`'s `id`, the same `chatId` the transport posts with every turn. */
  chatId: string;
  /**
   * The conversation's channel, already resolved with the options the
   * transport owns. Publish on it, for example a cancel message for an agent
   * that is subscribed to the channel, and leave attaching and detaching it
   * to the transport.
   */
  channel: Ably.RealtimeChannel;
}

/**
 * A turn the backend is running, as {@link ChatTransportOptions.activeTurn}
 * reports it.
 */
export interface ActiveTurn {
  /**
   * A non-empty serial at or before the turn's first chunk, normally the
   * serial of the prompt the backend published for the turn. The transport
   * replays the latest turn on the channel when its `start` chunk is at or
   * after this serial, and otherwise waits for the next turn to start.
   *
   * Leave it out, or set it to `null`, while the backend does not know one
   * yet; the transport then takes the turn running on the channel, or the
   * next one to start. A turn whose agent died also looks running there, and
   * is replayed in place of the new one, so name the turn with `from` as soon
   * as its prompt's serial is known.
   */
  from?: string | null;
}

/**
 * Options for {@link createChatTransport}.
 */
export interface ChatTransportOptions {
  /** The application's Ably Realtime client. The transport reads the channel through it and never closes it. */
  client: Ably.Realtime;
  /**
   * The conversation's channel. Use one channel per conversation: the agent
   * publishes its reply there with `createTransport` and the Vercel codec.
   *
   * The transport resolves the channel, with the options it owns, when it is
   * created, and attaches it on first use. Create the transport before other
   * code asks for the channel; that code then asks by name with no options of
   * its own, and gets the channel the transport resolved. Leave the first
   * attach to the transport too: history reaches back only to where the
   * channel attached, so a channel that other code attached first hides what
   * was published between that attach and the transport's first call.
   *
   * Keep one chat transport per channel on a client. Closing one detaches the
   * channel under every listener on it: another chat transport reads the
   * channel again on its next call, but a reply it is streaming gets nothing
   * more until `stop()` or that next call, which ends it as a stop.
   */
  channelName: string;
  /** The endpoint a turn is posted to. Default `'/api/chat'`. */
  api?: string;
  /**
   * Called when `useChat` stops a reply this transport handed it, so the
   * application can tell the agent to stop. Called with the context to
   * observe, just after the transport ends the reply in this tab. It may
   * return a promise, which is not awaited; a throw or a rejection is
   * logged. Omit it and a stop ends the reply in this tab only: the abort
   * also cancels the request `sendMessages` posted, which stops an agent
   * that runs inside that request, but any other agent runs on, and the next
   * `sendMessages` waits for its turn to end.
   *
   * `useChat` stops a reply on `stop()`, and from `@ai-sdk/react` 4.0.101 when
   * its component unmounts; `AbstractChat`'s `dispose()` stops it too. An
   * unmount is a disconnect rather than a stop, as the AI SDK's resume guide
   * (https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) puts it: the
   * tab goes away, and the reply runs on for whoever rejoins it. So `onStop`
   * runs a microtask after the abort, and is not called when `close()` or
   * `reconnectToStream` comes straight after the abort, before any `await`.
   * On unmount, React runs an effect cleanup that closes the transport in
   * just that way, provided the cleanup sits in the component that calls
   * `useChat`. `useChat` calls `reconnectToStream` in that way too, when it
   * replaces a reply it resumed. `dispose()` awaits the stop before it
   * closes, so it does call
   * `onStop`. Nor is `onStop` called for an abort that lands while
   * `sendMessages` or `reconnectToStream` is still waiting, since no reply was
   * handed back.
   *
   * How to reach the agent is the deployment's choice. An agent with an
   * address of its own, such as a durable workflow, takes a request to an
   * endpoint of the application's. An agent subscribed to the channel takes a
   * publish on `channel`. An agent that runs inside the request
   * `sendMessages` posts is stopped by that request's abort instead, which
   * `useChat`'s abort signal triggers on every stop, and from `@ai-sdk/react`
   * 4.0.101 on unmount too.
   * @param context - The chat's id and the conversation's channel; see {@link StopContext}.
   * @returns Nothing, or a promise the transport does not wait for.
   */
  onStop?: (context: StopContext) => void | PromiseLike<void>;
  /**
   * Answers what is running, for `reconnectToStream`. Resolve `null` when no
   * turn is running, `{}` when one is but its position is not known, and
   * `{ from }` to name it; see {@link ActiveTurn}.
   *
   * Omit it and the transport answers from the channel: the latest turn there
   * is running if its `start` chunk has no terminal chunk after it. Pass it
   * when the backend knows better: an agent that died before publishing a
   * terminal chunk leaves a turn that looks like it is still running, and a
   * turn the backend has accepted but whose agent has not published yet is
   * not on the channel at all.
   *
   * The answer is only as good as the backend's record. A backend that
   * publishes the prompt records the turn as running first, so a tab that
   * calls `reconnectToStream` when it sees the prompt finds it. It clears the
   * record on every exit: a `{ from }` left behind replays the finished turn
   * on every mount, as a fresh message. A rejection, such as one from reading
   * an error page as JSON, rejects `reconnectToStream`, as
   * `SessionHistoryFetchFailed` unless it is already an `Ably.ErrorInfo`.
   * @param chatId - The chat's id, as {@link StopContext.chatId}.
   * @returns The running turn, or `null` when there is none.
   */
  activeTurn?: (chatId: string) => Promise<ActiveTurn | null>;
  /** Logger for diagnostics, such as an `onStop` that failed. Silent when omitted. */
  logger?: Logger;
}

/**
 * A `ChatTransport` whose replies arrive over an Ably channel. Pass it to
 * `useChat` as `transport`. Create one per conversation and keep it: it
 * reads the channel from its first call until `close()`.
 *
 * A turn's chunks run from its `start` chunk to the first terminal chunk
 * after it: `finish`, `abort` or `error`. `toUIMessageStream` writes both
 * ends: it opens the agent's stream with `start`, and ends it with `finish`,
 * or with `abort` when the model call is aborted; when the model fails it
 * writes `error` and then `finish`, and the turn ends at the `error`. On an
 * exit that skips all of these, the agent publishes `abort` or `error`
 * itself; without a terminal chunk `useChat` stays `streaming` until
 * `stop()`. An agent that merges several UI message streams into one turn
 * writes `start` only from the first and `finish` only from the last: it
 * passes `sendStart: false` to every other stream, and `sendFinish: false` to
 * every stream but the last. An agent that fails before it has streamed
 * anything publishes `error`, which ends the turn too. A reply carries only
 * what the agent writes from the turn's `start` to its terminal chunk, and
 * anything written before or after reaches no reply. So an agent that writes
 * data parts once the model has finished writes them before the turn's
 * `finish`: it merges the model's stream with `sendFinish: false`, and writes
 * `finish` itself after its last part.
 *
 * Turns on a channel run one at a time: `sendMessages` waits for a running
 * turn before it posts. A turn that starts before the previous one has ended
 * anyway, such as from another tab, ends the replies still reading the
 * previous one, and two turns that stream at once are mixed. When the
 * channel loses continuity, as after a long disconnection, a reply may miss
 * chunks, and can wait for a terminal chunk it missed until `stop()` or the
 * next call. That next call reads the channel again: it detaches and
 * re-attaches the channel, which every other listener on it sees too, reads
 * history, and ends every reply still open from before as a stop, without
 * calling `onStop`.
 *
 * A stream stopped by `useChat`'s abort signal or by `close()` ends with an
 * `OperationCancelled` error named `AbortError`, as an aborted fetch does, so
 * `useChat` treats it as a stop rather than a failure. So does a call that
 * its abort signal stops while it waits, and a `sendMessages` that `close()`
 * stops while it waits. A `reconnectToStream` that `close()` stops returns
 * `null`.
 */
export interface AblyChatTransport extends ChatTransport<AI.UIMessage> {
  /**
   * Post a turn to the backend and return its reply, read off the channel.
   *
   * The transport is reading the channel before it posts, so it cannot miss
   * the first chunk. It posts `{ ...body, chatId, trigger, messageId, messages }`
   * as JSON to `api`, with the request's `headers` and `abortSignal`, and does
   * not wait for the response: a backend that runs the agent inside the
   * request holds it open for the whole turn. The transport publishes
   * nothing; the backend's agent writes the reply.
   *
   * While the latest turn's agent is still publishing, such as one this tab
   * has just stopped, the call waits for it before it posts, so the two do
   * not stream at once and its last chunks do not land in the new reply.
   * After an `error`, it also waits for the `finish` the AI SDK writes after
   * the `error`. The call stops waiting once that turn has published nothing
   * for 10 seconds while it runs, or for 2 seconds after its `error`, since
   * its agent has most likely died. An agent that is alive but silent for
   * that long, as during a long tool call, can then stream beside the new
   * turn, and the two replies mix. When `abortSignal` fires during the wait,
   * nothing is posted. A turn this tab stopped before its `start` chunk
   * arrived is not known yet: if its agent publishes anyway, after this call
   * has posted, its chunks can land in the new reply.
   *
   * The stream carries the next turn to start on the channel, from its
   * `start` chunk, and closes after its terminal chunk. An `error` chunk that
   * arrives while no turn is running, from an agent that failed before it
   * streamed anything, ends it too. The stream errors with
   * `SessionSendFailed` when the request fails, or answers with a status
   * outside 2xx, before the reply has ended; a failure after that is only
   * logged. It errors with `SessionMessageProcessingFailed` when a message
   * that arrives while its turn runs cannot be decoded. It ends with
   * `OperationCancelled` when `abortSignal` fires, which calls `onStop` (see
   * {@link ChatTransportOptions.onStop} for when), or when `close()` is called.
   * @param options - What `useChat` passes: the trigger, the chat's id, the message to regenerate, the conversation, the abort signal, and the request's `headers` and `body`.
   * @returns The reply's chunks.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when `headers`, `body` or `messages` cannot be made into a request; `OperationCancelled` when `abortSignal` fires, or `close()` is called, before the turn is posted, and then nothing is posted; `SessionSubscriptionFailed`, with the failure as `cause`, when the channel cannot be read, such as an attach it refused, or `SessionHistoryFetchFailed` when its history cannot be read.
   */
  sendMessages(
    options: Parameters<AI.ChatTransport<AI.UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<AI.UIMessageChunk>>;

  /**
   * Rejoin the turn that is running, for `useChat`'s `resume`: replay it from
   * its `start` chunk, then follow it live, as one stream that closes after
   * its terminal chunk.
   *
   * Without `activeTurn`, a stream comes back when the latest turn on the
   * channel is running, and `null` when it has finished or there is none.
   * With `activeTurn`, its answer decides: `null` returns `null`; `{}` returns
   * the turn running on the channel, or the next one to start; `{ from }`
   * returns the latest turn if its `start` chunk is at or after `from`, even
   * one that has just finished, and otherwise the next one to start.
   *
   * The transport keeps reading the channel after the call, even after it
   * returns `null`, so a later call finds a turn that started in between.
   * When `close()` is called while the call is still looking, the call
   * returns `null` too. When `abortSignal` fires after the stream is
   * returned, the stream ends with `OperationCancelled` and `onStop` is
   * called, unless `close()` or another `reconnectToStream` follows straight
   * away; see {@link ChatTransportOptions.onStop}. `close()` ends the stream
   * the same way, without `onStop`. The stream errors with
   * `SessionMessageProcessingFailed` when a message that arrives while it
   * follows the turn cannot be decoded.
   *
   * A rejoined reply is `useChat`'s like any other, so every tab that rejoins
   * a turn runs `onToolCall` for its client-side tool calls, and may send the
   * next turn through `sendAutomaticallyWhen`.
   * @param options - What `useChat` passes: the chat's id and the abort signal, which `useChat` passes from `ai` 7.0.56 and 6.0.249. The request's `headers` and `body` are not used, since nothing is requested.
   * @returns The turn's chunks, or `null` when no turn is running or `close()` was called while the call was still looking.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when `abortSignal` fires before the stream is returned; `InvalidArgument` when `activeTurn` resolves to something other than `null` or an {@link ActiveTurn}, an empty `from` included; what `activeTurn` rejected with, unchanged when it is an `Ably.ErrorInfo` and otherwise as `SessionHistoryFetchFailed` carrying its message; `SessionSubscriptionFailed`, with the failure as `cause`, when the channel cannot be read, such as an attach it refused, or `SessionHistoryFetchFailed` when its history cannot be read.
   */
  reconnectToStream(
    // `abortSignal` is spelled out for the releases in the peer range whose
    // `ChatTransport` type lacks it.
    options: Parameters<AI.ChatTransport<AI.UIMessage>['reconnectToStream']>[0] & { abortSignal?: AbortSignal },
  ): Promise<ReadableStream<AI.UIMessageChunk> | null>;

  /**
   * Always `true`. A resumed stream replays its turn from the `start` chunk,
   * so a chat that reads this builds the reply as a fresh message rather
   * than continuing one it already holds; {@link createChatTransport} lists
   * the releases that read it. The replay holds that turn's chunks only: a
   * turn that continues an assistant message, after a tool result or an
   * approval, opens with chunks about that message's tool calls, and
   * rejoining it fails or leaves those calls out, as it does for the AI SDK's
   * own resumable streams.
   */
  readonly resumeStreamIsReplay: true;

  /**
   * Stop reading the channel. Closing is a disconnect, not a stop: a reply
   * still streaming ends with `OperationCancelled`, which `useChat` reads as
   * a stop, but `onStop` is not called and the agent runs on. A
   * `sendMessages` still waiting rejects with `OperationCancelled`, and a
   * `reconnectToStream` still looking returns `null`. Then the transport
   * unsubscribes and detaches the channel, which cuts off every listener on
   * it, the application's own included.
   *
   * Safe to call more than once, and safe to call early: the next
   * `sendMessages` or `reconnectToStream` starts reading again, until
   * `close()` is called again.
   *
   * `AbstractChat.dispose()` calls it after stopping the reply, from `ai`
   * 7.0.135 (`ai` 6 has no `dispose()`). `useChat` from `@ai-sdk/react` never
   * does, so an application using it calls `close()` itself when the
   * conversation goes away, in an effect cleanup in the component that calls
   * `useChat`. On unmount React runs that cleanup and `useChat`'s own one
   * after the other, with no `await` between, which keeps the unmount from
   * calling `onStop`; see {@link ChatTransportOptions.onStop}.
   */
  close(): void;
}

/** The endpoint a turn is posted to when the options name none. */
const DEFAULT_API = '/api/chat';

/** How long a running turn may publish nothing before a send stops waiting for it: by then its agent has most likely died. */
const RUNNING_TURN_QUIET_MS = 10_000;

/** How long a send waits after a turn's `error` for the `finish` the AI SDK writes after it. */
const ERROR_TAIL_QUIET_MS = 2000;

/** How many characters of a failed response's body go into the error. */
const RESPONSE_EXCERPT_CHARS = 200;

/** What `useChat` passes to `sendMessages`. */
type SendMessagesOptions = Parameters<AblyChatTransport['sendMessages']>[0];

/** What `useChat` passes to `reconnectToStream`. */
type ReconnectToStreamOptions = Parameters<AblyChatTransport['reconnectToStream']>[0];

/** Which turn a reply carries: the next to start, or the latest, replayed from its start. */
type ReplyStart = 'next turn' | 'latest turn';

/** What `activeTurn` answered, once checked, with a `null` `from` left out. */
interface CheckedTurn {
  /** A non-empty serial at or before the turn's first chunk. */
  readonly from?: string;
}

/** What `reconnectToStream` resolves with when no turn is running. */
// eslint-disable-next-line unicorn/no-null -- the ChatTransport contract says "nothing is running" with null
const NOTHING_RUNNING = null;

/** A turn's request, built before the transport waits on anything. */
interface TurnRequest {
  /** The headers, with a content type. */
  readonly headers: Headers;
  /** The JSON body. */
  readonly body: string;
}

/** A stop that `onStop` has not been told about yet. */
interface PendingStop {
  /** The chat it belongs to. */
  readonly chatId: string;
}

/**
 * Wait for `work`, unless `signal` fires first.
 * @param work - What to wait for.
 * @param signal - `useChat`'s abort signal.
 * @param operation - The call that is waiting, for the error.
 * @returns What `work` resolved with.
 * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fires first; otherwise whatever `work` rejected with.
 */
const untilAborted = async <T>(work: Promise<T>, signal: AbortSignal | undefined, operation: string): Promise<T> => {
  if (signal === undefined) return work;
  if (signal.aborted) throw stoppedError(operation, ABORTED);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(stoppedError(operation, ABORTED));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
};

/**
 * Wait until a turn's agent has finished publishing it, until a running turn
 * ends, or until the turn has gone `quietMs` without a chunk.
 * @param turn - The turn.
 * @param quietMs - How long the turn may go without a chunk.
 * @param signal - `useChat`'s abort signal.
 * @param operation - The call that is waiting, for the error.
 * @returns `'settled'` when the agent finished, `'ended'` when a running turn ended, `'quiet'` when the turn went quiet.
 * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fires first.
 */
const untilSettledOrQuiet = async (
  turn: LatestTurn,
  quietMs: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<'settled' | 'ended' | 'quiet'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quiet = new Promise<'quiet'>((resolve) => {
    const check = (): void => {
      const idle = Date.now() - turn.lastChunkAt;
      if (idle >= quietMs) {
        resolve('quiet');
        return;
      }
      timer = setTimeout(check, quietMs - idle);
    };
    check();
  });
  try {
    // `.then` tags which one settles first. A turn that has already ended
    // leaves `whenEnded` out, since it has resolved.
    const outcomes: Promise<'settled' | 'ended' | 'quiet'>[] = [turn.settled.then((): 'settled' => 'settled'), quiet];
    if (!turn.ended) outcomes.push(turn.whenEnded.then((): 'ended' => 'ended'));
    return await untilAborted(Promise.race(outcomes), signal, operation);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Whether a turn started at or after a serial.
 * @param turn - The turn, if there is one.
 * @param from - The serial.
 * @returns True when the turn's `start` chunk is at or after `from`.
 */
const startedAtOrAfter = (turn: LatestTurn | undefined, from: string): boolean =>
  turn !== undefined && turn.startSerial >= from;

/**
 * Whether a value is a plain object, as JSON parsing makes one, rather than
 * an array or an instance of a class.
 * @param value - The value.
 * @returns True for a plain object.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Check what `activeTurn` resolved with: the answer comes from the
 * application, often straight off a response body.
 * @param answer - The resolved value.
 * @returns The answer, with a `null` `from` left out.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when it is neither `null` nor a plain object whose `from` is absent, `null` or a non-empty string.
 */
const toCheckedTurn = (answer: unknown): CheckedTurn | null => {
  if (answer === null) return NOTHING_RUNNING;
  if (isPlainObject(answer)) {
    const { from } = answer;
    if (from === undefined || from === null) return {};
    if (typeof from === 'string' && from !== '') return { from };
  }
  throw new Ably.ErrorInfo(
    'unable to reconnect to stream; activeTurn must resolve to null or { from?: string | null } with a non-empty from',
    ErrorCode.InvalidArgument,
    400,
  );
};

/**
 * What a failed response says about itself: the start of its body, or its
 * status text when the body is empty or cannot be read.
 * @param response - The response.
 * @returns The text.
 */
const responseText = async (response: Response): Promise<string> => {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return response.statusText;
  }
  if (text === '') return response.statusText;
  return text.length > RESPONSE_EXCERPT_CHARS ? `${text.slice(0, RESPONSE_EXCERPT_CHARS)}…` : text;
};

/**
 * The error for a turn whose request cannot be built.
 * @param reason - Why, for the message.
 * @returns The error.
 */
const invalidRequest = (reason: string): Ably.ErrorInfo =>
  new Ably.ErrorInfo(`unable to send messages; ${reason}`, ErrorCode.InvalidArgument, 400);

/**
 * Build the request for a turn.
 * @param options - What `useChat` passed to `sendMessages`.
 * @returns The headers, with a content type, and the JSON body.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the headers, body or messages cannot be made into a request.
 */
const requestOf = (options: SendMessagesOptions): TurnRequest => {
  const { chatId, trigger, messageId, messages } = options;
  let headers: Headers;
  try {
    headers = new Headers(options.headers);
  } catch {
    // The runtime's message quotes the value it rejected, which can be a
    // credential, so the error names no value.
    throw invalidRequest('the request headers are not valid HTTP headers');
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  try {
    return { headers, body: JSON.stringify({ ...options.body, chatId, trigger, messageId, messages }) };
  } catch (error) {
    throw invalidRequest(errorMessage(error));
  }
};

class DefaultAblyChatTransport implements AblyChatTransport {
  readonly resumeStreamIsReplay = true;
  private readonly _client: Ably.Realtime;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _api: string;
  private readonly _onStop: ((context: StopContext) => void | PromiseLike<void>) | undefined;
  private readonly _activeTurn: ((chatId: string) => Promise<ActiveTurn | null>) | undefined;
  private readonly _logger: Logger;
  /** Stops whose `onStop` waits for the microtask after the abort. */
  private readonly _pendingStops = new Set<PendingStop>();
  /** The reader serving replies, from the first call until `close()`. */
  private _reader: TurnReader | undefined;
  /** Counts `close()` calls, so a call still waiting can tell that the transport closed meanwhile. */
  private _closes = 0;

  constructor(options: ChatTransportOptions) {
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ChatTransport',
      channel: options.channelName,
    });
    this._client = options.client;
    this._api = options.api ?? DEFAULT_API;
    this._onStop = options.onStop;
    this._activeTurn = options.activeTurn;
    // Resolved now, with the options the transport owns, so application code
    // that asks for the channel by name gets this one.
    this._channel = resolveChannel(
      { client: options.client, channelName: options.channelName, codec: vercel },
      this._logger,
      'ChatTransport',
      'create chat transport',
    );
  }

  async sendMessages(options: SendMessagesOptions): Promise<ReadableStream<AI.UIMessageChunk>> {
    const { chatId, trigger, abortSignal } = options;
    this._logger.trace('ChatTransport.sendMessages();', { chatId, trigger });
    const operation = 'send messages';
    const request = this._buildRequest(options);
    const closes = this._closes;
    try {
      for (;;) {
        const reader = await this._waitForLiveReader(abortSignal, operation, closes);
        await this._untilLatestTurnSettles(reader, chatId, abortSignal, operation);
        // `close()` or a later call can replace the reader during the wait;
        // the wait for a live reader then throws or moves to the new one.
        // From this check on, nothing awaits until the turn is posted.
        if (reader !== this._reader || reader.stale) continue;
        const stream = this._openReply(reader, chatId, abortSignal, 'next turn', operation);
        // Not awaited: a backend that runs the agent inside the request holds
        // it open for the whole turn. A failure reaches `useChat` through the
        // stream.
        void this._post(request, abortSignal, chatId, stream);
        return stream.readable;
      }
    } catch (error) {
      if (this._closes !== closes) {
        this._logger.debug('ChatTransport.sendMessages(); the transport closed before posting', { chatId });
        throw stoppedError(operation, CLOSED);
      }
      if (abortSignal?.aborted === true) {
        this._logger.debug('ChatTransport.sendMessages(); stopped before posting', { chatId });
      }
      throw error;
    }
  }

  async reconnectToStream(options: ReconnectToStreamOptions): Promise<ReadableStream<AI.UIMessageChunk> | null> {
    const { chatId, abortSignal } = options;
    this._logger.trace('ChatTransport.reconnectToStream();', { chatId });
    // `useChat` aborts a reply it resumed just before it resumes again, and
    // replacing a reply is not a stop.
    this._cancelPendingStops();
    const closes = this._closes;
    // Read the channel while the backend is asked, and keep reading after a
    // `null`, so a later call finds a turn that starts in between.
    this._ensureReader();
    try {
      return await this._rejoin(chatId, abortSignal, closes);
    } catch (error) {
      // A call that `close()` overtook resolves `null`, where `sendMessages`
      // rejects. Every supported `ai` release reads `null` as nothing
      // running, but some show a rejection as the chat's error, so the error
      // is dropped.
      if (this._closes === closes) throw error;
      this._logger.debug('ChatTransport.reconnectToStream(); the transport closed while looking', { chatId });
      return NOTHING_RUNNING;
    }
  }

  close(): void {
    this._logger.trace('ChatTransport.close();');
    this._closes += 1;
    // An abort just before this, with no `await` between, is an unmount: a
    // disconnect, not a stop.
    this._cancelPendingStops();
    const reader = this._reader;
    if (reader === undefined) return;
    this._reader = undefined;
    // Not awaited: it never rejects, and the next reader on the channel
    // waits for it.
    void reader.close();
    this._logger.info('ChatTransport.close(); stopped reading the channel');
  }

  /**
   * The reader serving replies. Opens one on first use, and again when the
   * current one is stale: it could not read the channel, or the channel lost
   * continuity under it. Replacing a stale reader closes it, which ends the
   * replies still reading it as a stop.
   * @returns The reader.
   */
  private _ensureReader(): TurnReader {
    const current = this._reader;
    if (current !== undefined && !current.stale) return current;
    // Not awaited: it never rejects, and the new reader waits for it. Only a
    // reader that lost continuity can have replies to end: one that could
    // not read the channel never handed any out.
    if (current !== undefined) void current.close(LOST_CONTINUITY);
    const reader = new TurnReader({ client: this._client, channel: this._channel, logger: this._logger });
    this._reader = reader;
    this._logger.info('ChatTransport; reading the channel', { again: current !== undefined });
    return reader;
  }

  /**
   * Wait until the reader serving replies is live, and return it. When a
   * later call replaces the reader during the wait, wait for the new one.
   * @param signal - `useChat`'s abort signal.
   * @param operation - The call that is waiting, for the error.
   * @param closes - The count of `close()` calls when the call began.
   * @returns The live reader.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fires or the transport closes first; the reader's failure otherwise.
   */
  private async _waitForLiveReader(
    signal: AbortSignal | undefined,
    operation: string,
    closes: number,
  ): Promise<TurnReader> {
    for (;;) {
      // Checked before a reader is opened: a call that `close()` overtook
      // must not read the channel again.
      if (this._closes !== closes) throw stoppedError(operation, CLOSED);
      const reader = this._ensureReader();
      try {
        await untilAborted(reader.ready, signal, operation);
      } catch (error) {
        // A reader closed or replaced during the wait failed for that
        // reason, not this call's: go round, and the check above throws if
        // `close()` was called.
        if (this._closes !== closes || reader !== this._reader) continue;
        throw error;
      }
      if (reader === this._reader && !reader.stale) return reader;
    }
  }

  /**
   * Find the turn to rejoin, and open a reply on it.
   * @param chatId - The chat.
   * @param signal - `useChat`'s abort signal.
   * @param closes - The count of `close()` calls when the call began.
   * @returns The reply's stream, or `null` when no turn is running.
   * @throws {Ably.ErrorInfo} What `reconnectToStream` documents; `OperationCancelled` when the transport closes first.
   */
  private async _rejoin(
    chatId: string,
    signal: AbortSignal | undefined,
    closes: number,
  ): Promise<ReadableStream<AI.UIMessageChunk> | null> {
    const operation = 'reconnect to stream';
    const answer = await this._askActiveTurn(chatId, signal, operation);
    if (answer === null) {
      this._logger.debug('ChatTransport.reconnectToStream(); activeTurn says nothing is running', { chatId });
      return NOTHING_RUNNING;
    }
    const reader = await this._waitForLiveReader(signal, operation, closes);
    const latest = reader.latest;
    const running = latest?.ended === false;
    if (answer === undefined && !running) {
      this._logger.debug('ChatTransport.reconnectToStream(); no turn running', { chatId });
      return NOTHING_RUNNING;
    }
    // Replay the latest turn when it is the one asked for: the running turn
    // when there is no `from`, or a turn that started at or after `from`.
    // Otherwise the reply waits for the next turn to start.
    const from = answer?.from;
    const replay = from === undefined ? running : startedAtOrAfter(latest, from);
    this._logger.debug('ChatTransport.reconnectToStream(); rejoining', { chatId, from, replay });
    return this._openReply(reader, chatId, signal, replay ? 'latest turn' : 'next turn', operation).readable;
  }

  /**
   * Ask `activeTurn` what is running, when the application gave one.
   * @param chatId - The chat.
   * @param signal - `useChat`'s abort signal.
   * @param operation - The call that is asking, for the error.
   * @returns The checked answer, or `undefined` when there is no `activeTurn`.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fires first; `InvalidArgument` for an answer that is not one; what `activeTurn` rejected with, as `SessionHistoryFetchFailed` unless it is an `Ably.ErrorInfo`.
   */
  private async _askActiveTurn(
    chatId: string,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<CheckedTurn | null | undefined> {
    const activeTurn = this._activeTurn;
    if (activeTurn === undefined) return undefined;
    // Checked before `activeTurn` is called, so a call already stopped asks
    // the backend nothing.
    if (signal?.aborted === true) throw stoppedError(operation, ABORTED);
    let answer: unknown;
    try {
      answer = await untilAborted(activeTurn(chatId), signal, operation);
    } catch (error) {
      if (error instanceof Ably.ErrorInfo && errorInfoIs(error, ErrorCode.OperationCancelled)) throw error;
      // The lookup stands in for reading history, so a failure that is not
      // already an `Ably.ErrorInfo` is reported under the history code.
      const failure =
        error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo(
              `unable to reconnect to stream; activeTurn rejected: ${errorMessage(error)}`,
              ErrorCode.SessionHistoryFetchFailed,
              500,
            );
      this._logger.error('ChatTransport.reconnectToStream(); activeTurn rejected', {
        chatId,
        error: failure.message,
      });
      throw failure;
    }
    try {
      return toCheckedTurn(answer);
    } catch (error) {
      this._logger.error('ChatTransport.reconnectToStream(); activeTurn resolved to an invalid answer', {
        chatId,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Wait while the latest turn's agent is still publishing, so the turn about
   * to be posted cannot stream at the same time. Stop waiting when the turn
   * goes quiet, as it does when its agent has died.
   * @param reader - The live reader.
   * @param chatId - The chat, for the log.
   * @param signal - `useChat`'s abort signal.
   * @param operation - The call that is waiting, for the error.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fires first.
   */
  private async _untilLatestTurnSettles(
    reader: TurnReader,
    chatId: string,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<void> {
    // Look again after each wait: a newer turn may have started, or the turn
    // may have ended with an `error` and now waits only for its tail.
    for (let turn = reader.latest; turn?.publishing === true; turn = reader.latest) {
      // A turn that has ended but is still publishing ended with an `error`:
      // the AI SDK still writes a `finish` after it.
      const awaitingErrorTail = turn.ended;
      this._logger.debug('ChatTransport.sendMessages(); waiting for the latest turn', {
        chatId,
        turn: turn.startSerial,
      });
      const outcome = await untilSettledOrQuiet(
        turn,
        awaitingErrorTail ? ERROR_TAIL_QUIET_MS : RUNNING_TURN_QUIET_MS,
        signal,
        operation,
      );
      if (outcome === 'quiet') {
        if (!awaitingErrorTail) {
          this._logger.warn('ChatTransport.sendMessages(); the running turn went quiet, so posting anyway', {
            chatId,
            turn: turn.startSerial,
          });
        }
        return;
      }
    }
  }

  /**
   * Open a reply: a stream that follows the reader and ends when `useChat`'s
   * signal fires.
   * @param reader - The live reader.
   * @param chatId - The chat, for `onStop`.
   * @param signal - `useChat`'s abort signal.
   * @param start - Which turn the reply carries.
   * @param operation - The call that opens it, for the error.
   * @returns The reply's stream.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal has already fired: nothing was handed back, so nothing is stopped.
   */
  private _openReply(
    reader: TurnReader,
    chatId: string,
    signal: AbortSignal | undefined,
    start: ReplyStart,
    operation: string,
  ): TurnStream {
    if (signal?.aborted === true) throw stoppedError(operation, ABORTED);
    const onAbort = (): void => {
      this._logger.debug('ChatTransport; reply aborted', { chatId });
      stream.fail(stoppedError('read the turn', ABORTED));
      this._deferStop({ chatId });
    };
    const stream = new TurnStream(() => {
      signal?.removeEventListener('abort', onAbort);
      reader.unfollow(stream);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (start === 'latest turn') reader.joinLatestTurn(stream);
    else reader.waitForNextTurn(stream);
    return stream;
  }

  /**
   * Tell the application about a stop a microtask after the abort, unless
   * `close()` or `reconnectToStream` comes first. React's unmount cleanups
   * close the transport straight after `useChat` aborts its reply, and
   * `useChat` calls `reconnectToStream` straight after aborting a reply it
   * resumed; neither is a stop.
   * @param stop - The stop.
   */
  private _deferStop(stop: PendingStop): void {
    this._pendingStops.add(stop);
    queueMicrotask(() => {
      if (!this._pendingStops.delete(stop)) return;
      // Not awaited: `_callOnStop` logs whatever `onStop` throws or rejects with.
      void this._callOnStop(stop.chatId);
    });
  }

  /**
   * Drop the stops `onStop` has not been told about yet: the abort that made
   * them was a disconnect.
   */
  private _cancelPendingStops(): void {
    if (this._pendingStops.size === 0) return;
    this._logger.debug('ChatTransport; not calling onStop: the abort was a disconnect', {
      replies: this._pendingStops.size,
    });
    this._pendingStops.clear();
  }

  /**
   * Call `onStop`, logging a throw or a rejection rather than letting either
   * escape.
   * @param chatId - The chat.
   */
  private async _callOnStop(chatId: string): Promise<void> {
    const onStop = this._onStop;
    if (onStop === undefined) return;
    this._logger.debug('ChatTransport; calling onStop', { chatId });
    try {
      await onStop({ chatId, channel: this._channel });
    } catch (error) {
      this._logger.error('ChatTransport; onStop threw', { chatId, error: errorMessage(error) });
    }
  }

  /**
   * Build the request for a turn, logging a request that cannot be built.
   * @param options - What `useChat` passed to `sendMessages`.
   * @returns The request.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the headers, body or messages cannot be made into a request.
   */
  private _buildRequest(options: SendMessagesOptions): TurnRequest {
    try {
      return requestOf(options);
    } catch (error) {
      this._logger.error('ChatTransport.sendMessages(); unable to build the request', {
        chatId: options.chatId,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Post a turn to the backend. A failure ends the reply, unless the reply
   * has already ended.
   * @param request - The turn's request.
   * @param signal - `useChat`'s abort signal, which aborts the request.
   * @param chatId - The chat, for the log.
   * @param stream - The reply.
   */
  private async _post(
    request: TurnRequest,
    signal: AbortSignal | undefined,
    chatId: string,
    stream: TurnStream,
  ): Promise<void> {
    let failure: Ably.ErrorInfo;
    // What the log says about the failure. A response's body can echo the
    // conversation, so a failed response logs only its status.
    let detail: { status: number } | { error: string };
    try {
      const response = await fetch(this._api, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal,
      });
      if (response.ok) {
        this._logger.debug('ChatTransport.sendMessages(); posted', { chatId, status: response.status });
        return;
      }
      detail = { status: response.status };
      failure = new Ably.ErrorInfo(
        `unable to send messages; ${this._api} answered ${String(response.status)}: ${await responseText(response)}`,
        ErrorCode.SessionSendFailed,
        response.status,
      );
    } catch (error) {
      failure = new Ably.ErrorInfo(
        `unable to send messages; ${errorMessage(error)}`,
        ErrorCode.SessionSendFailed,
        500,
        errorCause(error),
      );
      detail = { error: failure.message };
    }
    if (!stream.ended) {
      this._logger.error('ChatTransport.sendMessages(); the request failed', { chatId, ...detail });
      stream.fail(failure);
      return;
    }
    if (signal?.aborted === true) {
      this._logger.debug('ChatTransport.sendMessages(); the request was aborted with its reply', { chatId });
      return;
    }
    this._logger.warn('ChatTransport.sendMessages(); the request failed after its reply ended', {
      chatId,
      ...detail,
    });
  }
}

/**
 * Create a `ChatTransport` for one conversation, to pass to `useChat` as
 * `transport`. Replies arrive over the conversation's Ably channel, so give
 * `useChat` an `id` that maps to it and `resume: true` to rejoin a turn that
 * is running when the page loads.
 *
 * The channel is resolved here, with the options the transport owns, and
 * attached on first use; see {@link ChatTransportOptions.channelName}.
 *
 * Supports `ai` 6 and 7. Some behaviours the transport relies on arrived in
 * patch releases, and an older release does without them silently.
 * `@ai-sdk/react` depends on one exact `ai` release, so with `useChat`, the
 * `ai` release that `@ai-sdk/react` brings in is the one to check.
 *
 * - From `ai` 7.0.56 and 6.0.249, the chat passes its abort signal to
 *   `reconnectToStream`. Without it, `stop()` cannot end a reply this tab
 *   rejoined, and `onStop` is not called for one.
 * - From `ai` 7.0.61 and 6.0.250, a resumed reply starts a fresh assistant
 *   message. Without it, the reply is appended to the previous one.
 * - From `ai` 7.0.122 and 6.0.297, when a tab rejoins a reply whose message it
 *   already shows with a tool call still running, the chat repeats that
 *   message's parts unless it reads `resumeStreamIsReplay`. `AbstractChat`
 *   reads it from `ai` 7.0.135 and 6.0.304. `useChat` reads it from
 *   `@ai-sdk/react` 4.0.141; no 3.x release reads it.
 * - From `@ai-sdk/react` 4.0.101, `useChat` stops its reply when its
 *   component unmounts; see {@link ChatTransportOptions.onStop}.
 * @param options - See {@link ChatTransportOptions}.
 * @returns The transport.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `channelName` is empty; the failure `channels.get` raised, wrapped, when the channel was already resolved with other options and is attaching or attached.
 */
export const createChatTransport = (options: ChatTransportOptions): AblyChatTransport =>
  new DefaultAblyChatTransport(options);
