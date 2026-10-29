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

import * as Ably from '@ably/pubsub-core';
import type * as AI from 'ai';
// A named import for the one SDK type in a heritage clause: `import-x/namespace`
// cannot verify a namespaced generic in `extends`, though tsc resolves it.
import type { ChatTransport } from 'ai';

import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import { ABORTED, CLOSED, LOST_CONTINUITY, stoppedError } from './stopped.js';
import { TurnReader } from './turn-reader.js';
import { TurnStream } from './turn-stream.js';

/**
 * Options for {@link createChatTransport}.
 */
export interface ChatTransportOptions {
  /**
   * The conversation's channel, from the application's Pub/Sub client. Use
   * one channel per conversation: the agent publishes its reply there with
   * `vercelAdaptor`.
   *
   * The transport subscribes a listener of its own on its first call, and
   * attaches the channel if nothing has. History reaches back only to where
   * the channel attached, so leave the first attach to the transport: a
   * channel that other code attached first hides what was published between
   * that attach and the transport's first call, and once the channel loses
   * continuity, what was published between its re-attach and the transport's
   * next call. The channel's options are the application's, but give it no
   * `rewind` param: the messages a rewind replays on attach are also in the
   * history the transport reads, so the transport would take them twice.
   *
   * Keep one chat transport per channel on a client. Closing one detaches the
   * channel when the transport's read attached it, under every listener on
   * it: another chat transport reads the channel again on its next call, but
   * a reply it is streaming gets nothing more until `stop()` or that next
   * call, which ends it as a stop.
   */
  channel: Ably.RealtimeChannel;
  /** The endpoint a turn is posted to. Default `'/api/chat'`. */
  api?: string;
  /** Logger for diagnostics, such as a turn whose request failed. Silent when omitted. */
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
 * writes `error`, sometimes followed by `finish`, and the turn ends at the
 * `error`. On an exit that skips all of these, the agent publishes `abort` or
 * `error` itself, and when the agent dies before it can, whatever runs it,
 * such as a workflow, publishes `error` for it, which ends the reply even if
 * the agent died before its `start`. Without a terminal chunk the turn looks
 * like it is still running, and `useChat` stays `streaming` until `stop()` in
 * every tab that follows or rejoins it. An agent that merges several UI
 * message streams into one turn writes `start` only from the first and
 * `finish` only from the last: it passes `sendStart: false` to every other
 * stream, and `sendFinish: false` to every stream but the last. An agent that
 * fails before it has streamed anything publishes `error`, which ends the
 * turn too. A reply carries only what the agent writes from the turn's
 * `start` to its terminal chunk, and anything written before or after reaches
 * no reply. So an agent that writes data parts once the model has finished
 * writes them before the turn's `finish`: it merges the model's stream with
 * `sendFinish: false`, and writes `finish` itself after its last part.
 *
 * Turns on a channel run one at a time, and keeping them so is the
 * backend's job, since the transport cannot tell one turn's chunks from
 * another's: the backend starts a turn only once the previous turn has
 * published its terminal chunk, as an agent told to stop does with `abort`.
 * A reply waits for the next `start` chunk, so what the previous turn writes
 * before then reaches no reply. A turn that starts while the previous one is
 * still running ends the replies reading the previous one, and from then on
 * the two turns' chunks are mixed.
 *
 * When the channel loses continuity, as after a long disconnection, a reply
 * may miss chunks, and can wait for a terminal chunk it missed until `stop()`
 * or the next call. That next call reads the channel again: when the
 * transport's read attached the channel, it detaches and re-attaches it,
 * which every other listener on it sees too; it reads history, and ends
 * every reply still open from before as a stop.
 *
 * A stream stopped by `useChat`'s abort signal or by `close()` ends with an
 * `OperationCancelled` error named `AbortError`, as an aborted fetch does, so
 * `useChat` treats it as a stop rather than a failure. So does a call that
 * its abort signal stops while it waits, and a `sendMessages` that `close()`
 * stops while it waits. A `reconnectToStream` that `close()` stops returns
 * `null`.
 *
 * A stop reaches this tab and the request `sendMessages` posted, and nothing
 * else. Aborting that request stops an agent that runs inside it; an agent
 * that runs past the request goes on until the application tells it to stop,
 * from its Stop button's handler beside `useChat`'s `stop()`, with a request
 * to an endpoint of its own or a publish on the channel. `useChat` fires the
 * same abort when it replaces a reply it resumed and, from `@ai-sdk/react`
 * 4.0.101, when its component unmounts, so the transport cannot tell a stop
 * from a disconnect, and the cancel does not belong in cleanup code.
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
   * The call posts once the transport is reading the channel, even while the
   * latest turn on it is still running, such as one this tab has just
   * stopped: the backend starts the new turn once that one has ended; see
   * {@link AblyChatTransport}.
   *
   * The stream carries the next turn to start on the channel, from its
   * `start` chunk, and closes after its terminal chunk. An `error` chunk that
   * arrives while no turn is running, from an agent that failed before it
   * streamed anything, ends it too. The stream errors with
   * `SessionSendFailed` when the request fails, or answers with a status
   * outside 2xx, before the reply has ended; a failure after that is only
   * logged. It errors with `SessionMessageProcessingFailed` when a message
   * that arrives while its turn runs cannot be decoded. It ends with
   * `OperationCancelled` when `abortSignal` fires or `close()` is called.
   * @param options - What `useChat` passes: the trigger, the chat's id, the message to regenerate, the conversation, the abort signal, and the request's `headers` and `body`.
   * @returns The reply's chunks.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when `headers`, `body` or `messages` cannot be made into a request; `OperationCancelled` when `abortSignal` fires, or `close()` is called, before the turn is posted, and then nothing is posted; the failure's own code and status, `InternalError` when it has no code, with the failure as `cause`, when the channel cannot be read, such as an attach it refused or a history page that could not be fetched.
   */
  sendMessages(
    options: Parameters<AI.ChatTransport<AI.UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<AI.UIMessageChunk>>;

  /**
   * Rejoin the turn that is running, for `useChat`'s `resume`: replay it from
   * its `start` chunk, then follow it live, as one stream that closes after
   * its terminal chunk.
   *
   * The channel says what is running: a stream comes back when the latest
   * turn there is running, and `null` when it has finished or there is none.
   * A turn whose agent has not published anything yet is not on the channel,
   * so a call made before its `start` chunk returns `null`.
   *
   * The transport keeps reading the channel after the call, even after it
   * returns `null`, so a later call finds a turn that started in between.
   * When `close()` is called while the call is still looking, the call
   * returns `null` too. When `abortSignal` fires after the stream is
   * returned, or `close()` is called, the stream ends with
   * `OperationCancelled`. The stream errors with
   * `SessionMessageProcessingFailed` when a message that arrives while it
   * follows the turn cannot be decoded.
   *
   * A rejoined reply is `useChat`'s like any other, so every tab that rejoins
   * a turn runs `onToolCall` for its client-side tool calls, and may send the
   * next turn through `sendAutomaticallyWhen`.
   * @param options - What `useChat` passes: the chat's id and the abort signal, which `useChat` passes from `ai` 7.0.56 and 6.0.249. The request's `headers` and `body` are not used, since nothing is requested.
   * @returns The turn's chunks, or `null` when no turn is running or `close()` was called while the call was still looking.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when `abortSignal` fires before the stream is returned; the failure's own code and status, `InternalError` when it has no code, with the failure as `cause`, when the channel cannot be read, such as an attach it refused or a history page that could not be fetched.
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
   * Stop reading the channel. A reply still streaming ends with
   * `OperationCancelled`, which `useChat` reads as a stop, and the agent runs
   * on. A `sendMessages` still waiting rejects with `OperationCancelled`, and
   * a `reconnectToStream` still looking returns `null`. Then the transport
   * unsubscribes, and detaches the channel when its own read attached it,
   * which cuts off every listener on the channel, the application's own
   * included. A channel the application attached first stays attached.
   *
   * Safe to call more than once, and safe to call early: the next
   * `sendMessages` or `reconnectToStream` starts reading again, until
   * `close()` is called again.
   *
   * `AbstractChat.dispose()` calls it after stopping the reply, from `ai`
   * 7.0.135 (`ai` 6 has no `dispose()`). `useChat` from `@ai-sdk/react` never
   * does, so an application using it calls `close()` itself when the
   * conversation goes away, such as in an effect cleanup.
   */
  close(): void;
}

/** The endpoint a turn is posted to when the options name none. */
const DEFAULT_API = '/api/chat';

/** How many characters of a failed response's body go into the error. */
const RESPONSE_EXCERPT_CHARS = 200;

/** What `useChat` passes to `sendMessages`. */
type SendMessagesOptions = Parameters<AblyChatTransport['sendMessages']>[0];

/** A turn's request, built before the transport waits on anything. */
interface TurnRequest {
  /** The headers, with a content type. */
  readonly headers: Headers;
  /** The JSON body. */
  readonly body: string;
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
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _api: string;
  private readonly _logger: Logger;
  /** The reader serving replies, from the first call until `close()`. */
  private _reader: TurnReader | undefined;
  /** Counts `close()` calls, so a call still waiting can tell that the transport closed meanwhile. */
  private _closes = 0;

  constructor(options: ChatTransportOptions) {
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ChatTransport',
      channel: options.channel.name,
    });
    this._channel = options.channel;
    this._api = options.api ?? DEFAULT_API;
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
        // `close()` or a later call can replace the reader before this call
        // resumes; the wait for a live reader then throws or moves to the new
        // one. From this check on, nothing awaits until the turn is posted.
        if (reader !== this._reader || reader.stale) continue;
        const stream = this._openReply(reader, chatId, abortSignal, operation);
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

  // eslint-disable-next-line @typescript-eslint/require-await -- a stub until rejoining a turn lands
  async reconnectToStream(): Promise<ReadableStream<AI.UIMessageChunk> | null> {
    throw new Ably.ErrorInfo('unable to reconnect to stream; not implemented', ErrorCode.InternalError, 500);
  }

  close(): void {
    this._logger.trace('ChatTransport.close();');
    this._closes += 1;
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
    const reader = new TurnReader({ channel: this._channel, logger: this._logger });
    this._reader = reader;
    this._logger.info('ChatTransport._ensureReader(); reading the channel', { again: current !== undefined });
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
   * Open a reply: a stream that follows the reader and ends when `useChat`'s
   * signal fires.
   * @param reader - The live reader.
   * @param chatId - The chat, for the log.
   * @param signal - `useChat`'s abort signal.
   * @param operation - The call that opens it, for the error.
   * @returns The reply's stream.
   * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal has already fired: nothing was handed back, so nothing is stopped.
   */
  private _openReply(
    reader: TurnReader,
    chatId: string,
    signal: AbortSignal | undefined,
    operation: string,
  ): TurnStream {
    if (signal?.aborted === true) throw stoppedError(operation, ABORTED);
    const onAbort = (): void => {
      this._logger.debug('ChatTransport._openReply(); reply aborted', { chatId });
      stream.fail(stoppedError('read the turn', ABORTED));
    };
    const stream = new TurnStream(() => {
      signal?.removeEventListener('abort', onAbort);
      reader.unfollow(stream);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.waitForNextTurn(stream);
    return stream;
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
 * The transport reads the channel from its first call until `close()`; see
 * {@link ChatTransportOptions.channel}.
 *
 * Supports `ai` 6 and 7. Some behaviours the transport relies on arrived in
 * patch releases, and an older release does without them silently.
 * `@ai-sdk/react` depends on one exact `ai` release, so with `useChat`, the
 * `ai` release that `@ai-sdk/react` brings in is the one to check.
 *
 * - From `ai` 7.0.56 and 6.0.249, the chat passes its abort signal to
 *   `reconnectToStream`. Without it, `stop()` cannot end a reply this tab
 *   rejoined.
 * - From `ai` 7.0.61 and 6.0.250, a resumed reply starts a fresh assistant
 *   message. Without it, the reply is appended to the previous one.
 * - From `ai` 7.0.122 and 6.0.297, when a tab rejoins a reply whose message it
 *   already shows with a tool call still running, the chat repeats that
 *   message's parts unless it reads `resumeStreamIsReplay`. `AbstractChat`
 *   reads it from `ai` 7.0.135 and 6.0.304. `useChat` reads it from
 *   `@ai-sdk/react` 4.0.141; no 3.x release reads it.
 * @param options - See {@link ChatTransportOptions}.
 * @returns The transport.
 */
export const createChatTransport = (options: ChatTransportOptions): AblyChatTransport =>
  new DefaultAblyChatTransport(options);
