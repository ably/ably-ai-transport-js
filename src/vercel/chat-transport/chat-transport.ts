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

class DefaultAblyChatTransport implements AblyChatTransport {
  readonly resumeStreamIsReplay = true;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _api: string;
  private readonly _logger: Logger;

  constructor(options: ChatTransportOptions) {
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ChatTransport',
      channel: options.channel.name,
    });
    this._channel = options.channel;
    this._api = options.api ?? DEFAULT_API;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the methods are stubs until the read path lands
  async sendMessages(): Promise<ReadableStream<AI.UIMessageChunk>> {
    throw new Ably.ErrorInfo('unable to send messages; not implemented', ErrorCode.InternalError, 500);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the methods are stubs until the read path lands
  async reconnectToStream(): Promise<ReadableStream<AI.UIMessageChunk> | null> {
    throw new Ably.ErrorInfo('unable to reconnect to stream; not implemented', ErrorCode.InternalError, 500);
  }

  close(): void {
    /* nothing to release until the read path lands */
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
