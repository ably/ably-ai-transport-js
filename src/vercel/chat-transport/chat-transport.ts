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
import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { vercel } from '../codec/index.js';

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

class DefaultAblyChatTransport implements AblyChatTransport {
  readonly resumeStreamIsReplay = true;

  constructor(options: ChatTransportOptions) {
    const logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ChatTransport',
      channel: options.channelName,
    });
    // Resolved now, with the options the transport owns, so application code
    // that asks for the channel by name gets this one.
    resolveChannel(
      { client: options.client, channelName: options.channelName, codec: vercel },
      logger,
      'ChatTransport',
      'create chat transport',
    );
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
