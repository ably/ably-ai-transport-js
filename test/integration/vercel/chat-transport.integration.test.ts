/**
 * Chat-transport integration tests over a real Ably channel.
 *
 * Every test here has three jobs, and they matter equally.
 *
 * 1. **Exercise the public API.** A test calls only what an application can
 *    call: what an `index.ts` re-exports. It never reaches into the adapter's
 *    fields or asserts on private state.
 * 2. **Demonstrate use.** A test reads as the code a developer would write to
 *    get the behaviour, in the order they would write it. Every SDK call stays
 *    in the body of the test: the client transport, the chat transport, the
 *    agent transport, the run and its pipe. Nothing is hidden behind a local
 *    setup helper, because a helper that wraps those calls hides the API the
 *    test exists to show.
 * 3. **Verify the behaviour.** A test fails when the behaviour breaks.
 *
 * The chain is the shipped one end to end, and the tests drive it from the top:
 *
 *   Chat (the AI SDK state container `useChat` wraps)
 *     → ChatTransport → ClientTransport → Ably → AgentTransport → run.pipe
 *
 * `Chat` comes from `@ai-sdk/react` and needs no React. It is the object
 * `useChat` is a thin hook over, so driving it exercises the SDK's own state
 * machine against our adapter, and its `messages` are assembled by the SDK's
 * reducer rather than by anything of ours. A test whose subject is
 * `readSince` or `reconnectToStream` calls the adapter directly instead,
 * because those have no `useChat` equivalent and an application calls them
 * itself (see `demo/shared-frontend/src/hooks/use-channel-hydration.ts`).
 *
 * The core transport tier is a sibling, in `../core/`.
 *
 * **Who calls `fetch`, and where the route comes from.** The adapter does, in
 * `ChatTransport._postChat`: every send path publishes the input to the
 * channel and then POSTs `{ channelName, eventId }` to wake the agent. The URL
 * is the `api` option on `createChatTransport`, which defaults to
 * `/api/chat`. These tests leave it at the default, so the stub below is
 * standing in for the application's own route handler at that path — in the
 * demos, `demo/vercel/react/use-chat/src/app/api/chat/route.ts`. There is no
 * HTTP server in the test process and `/api/chat` is relative with no origin,
 * so the route has to be a stub. The adapter never reads the response body;
 * only reachability and a 2xx status matter to it.
 *
 * Each stub attaches a fresh agent transport inside the request, as a
 * serverless route would. That is not a convenience: `history()` pages
 * backwards from the attach point, so a long-lived agent attached before the
 * client published can never locate that input. A route that attaches per
 * request has its attach point after the input.
 *
 * Nothing about the run travels back over HTTP: the client resolves the run id
 * off the channel by matching `input-transport-message-id` on `ai-run-start`.
 */

import '../../helper/expectations.js';

import { Chat } from '@ai-sdk/react';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentTransport } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createAgentTransport, createClientTransport } from '../../../src/vercel/transport/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { drain, readInto } from '../../helper/streams.js';
import { createEventRecorder } from '../helpers.js';

/**
 * The chunks of one complete assistant reply, split across two deltas so the
 * stream is genuinely incremental on the wire.
 * @param messageId - The assistant message's domain id.
 * @param text - The reply text.
 * @returns The chunk stream.
 */
const replyStream = (messageId: string, text: string): ReadableStream<AI.UIMessageChunk> => {
  const mid = Math.floor(text.length / 2);
  return new ReadableStream({
    start: (controller) => {
      controller.enqueue({ type: 'start', messageId });
      controller.enqueue({ type: 'text-start', id: 't1' });
      controller.enqueue({ type: 'text-delta', id: 't1', delta: text.slice(0, mid) });
      controller.enqueue({ type: 'text-delta', id: 't1', delta: text.slice(mid) });
      controller.enqueue({ type: 'text-end', id: 't1' });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
};

/**
 * The text a chunk sequence carries, concatenated in wire order. Used where
 * the subject is the chunk stream itself rather than the assembled message.
 * @param chunks - The chunks to read.
 * @returns The concatenated text deltas.
 */
const textOf = (chunks: AI.UIMessageChunk[]): string =>
  chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => ('delta' in chunk && typeof chunk.delta === 'string' ? chunk.delta : ''))
    .join('');

/**
 * The text of the newest assistant message the AI SDK assembled.
 * @param chat - The chat to read.
 * @returns The concatenated text of its last assistant message.
 */
const assistantText = (chat: Chat<AI.UIMessage>): string =>
  (chat.messages.findLast((message) => message.role === 'assistant')?.parts ?? [])
    .filter((part): part is AI.TextUIPart => part.type === 'text')
    .map((part) => part.text)
    .join('');

describe('chat transport over a real channel', () => {
  const openTransports: { close: () => void }[] = [];

  /**
   * Close these transports when the test ends, whatever the test does.
   * @param transports - The transports to close in `afterEach`.
   */
  const closeAfterTest = (...transports: { close: () => void }[]): void => {
    openTransports.push(...transports);
  };

  afterEach(() => {
    for (const transport of openTransports.splice(0)) transport.close();
    closeAllClients();
    vi.unstubAllGlobals();
  });

  it('a send streams the reply and closes on the run end', async () => {
    const channelName = uniqueChannelName('ct-send');

    // ---- the application's chat route, which the adapter POSTs to ----------
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          const run = agent.openRun({ input });
          await run.pipe(replyStream('a1', 'Berlin is 4C'));
          await run.end({ reason: 'complete' });
        }
        return new Response('', { status: 202 });
      }),
    );

    // ---- the browser -------------------------------------------------------
    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const chat = new Chat<AI.UIMessage>({ id: channelName, transport: chatTransport });

    // sendMessage resolves when the response has finished, so its returning at
    // all is the stream having closed on the run's end.
    await chat.sendMessage({ text: 'what is the weather?' });

    expect(chat.status).toBe('ready');
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(assistantText(chat)).toBe('Berlin is 4C');
    expect(chat.messages.at(-1)?.id).toBe('a1');
  }, 30_000);

  it('a run another participant started reaches an idle client', async () => {
    const channelName = uniqueChannelName('ct-foreign-idle');

    // ---- the participant who only watches ----------------------------------
    // It never sends, so every run it sees belongs to someone else.
    const watcherTransport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await watcherTransport.connect();
    const watcherChatTransport = createChatTransport({ transport: watcherTransport, channelName });
    closeAfterTest(watcherTransport, watcherChatTransport);
    const watcher = new Chat<AI.UIMessage>({ id: channelName, transport: watcherChatTransport });

    const offered: string[] = [];
    const prompts: VercelInput[] = [];
    watcherChatTransport.onForeignRun((runId) => offered.push(runId));
    watcherChatTransport.onForeignInput((input) => prompts.push(input));

    // ---- the participant who asks, and its route ---------------------------
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          const run = agent.openRun({ input });
          await run.pipe(replyStream('a1', 'four degrees'));
          await run.end({ reason: 'complete' });
        }
        return new Response('', { status: 202 });
      }),
    );

    const askerTransport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await askerTransport.connect();
    const askerChatTransport = createChatTransport({ transport: askerTransport, channelName });
    closeAfterTest(askerTransport, askerChatTransport);
    const asker = new Chat<AI.UIMessage>({ id: channelName, transport: askerChatTransport });
    await asker.sendMessage({ text: 'what is the weather?' });

    // The watcher was idle, so the adapter offered the run it saw start.
    await vi.waitFor(() => {
      expect(offered).toHaveLength(1);
    });

    // And it was given the prompt, which is what lets it render the question.
    expect(prompts.map((input) => input.kind)).toContain('message');
    const prompt = prompts.find((input) => input.kind === 'message');
    expect(prompt?.kind === 'message' && prompt.payload.parts).toEqual([
      { type: 'text', text: 'what is the weather?' },
    ]);

    // The application answers the offer the way the demo does: resume that run
    // by id. useChat takes new streamed content only through resumeStream.
    await watcher.resumeStream({ body: { runId: offered[0] } });
    expect(assistantText(watcher)).toBe('four degrees');
  }, 30_000);

  it('a run that started while this client was streaming is offered when it goes idle', async () => {
    const channelName = uniqueChannelName('ct-foreign-busy');

    // This client's own run is held open, so it is provably still streaming
    // when the other participant's run starts. The pipe is not awaited in the
    // route: it stays open, which is what leaves the run in flight.
    let mine: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;
    let piped: Promise<unknown> | undefined;
    let myRun: ReturnType<AgentTransport<VercelInput, VercelOutput>['openRun']> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          myRun = agent.openRun({ input });
          piped = myRun.pipe(
            new ReadableStream<AI.UIMessageChunk>({
              start: (controller) => {
                mine = controller;
                controller.enqueue({ type: 'start', messageId: 'a-mine' });
                controller.enqueue({ type: 'text-start', id: 't1' });
                controller.enqueue({ type: 'text-delta', id: 't1', delta: 'mine' });
              },
            }),
          );
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const chat = new Chat<AI.UIMessage>({ id: channelName, transport: chatTransport });

    const offered: string[] = [];
    chatTransport.onForeignRun((runId) => offered.push(runId));

    // Not awaited: the run stays open, so the send is still in flight.
    const sending = chat.sendMessage({ text: 'my question' });
    await vi.waitFor(() => {
      expect(chatTransport.streaming).toBe(true);
    });

    // A second agent opens a run of its own while this client is mid-stream.
    const other = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    closeAfterTest(other);
    await other.connect();
    const theirRun = other.openRun();
    await theirRun.pipe(replyStream('a-theirs', 'theirs'));

    // The idle gate held: nothing was offered while this client was streaming.
    expect(offered).toEqual([]);

    // This client's own run finishes, so the adapter goes idle. The pipe is
    // awaited before the terminal, because ending a run while its pipe is
    // still flushing cuts the rest of the reply off the wire.
    mine?.enqueue({ type: 'text-end', id: 't1' });
    mine?.enqueue({ type: 'finish', finishReason: 'stop' });
    mine?.close();
    await piped;
    await myRun?.end({ reason: 'complete' });
    await sending;

    // Now idle with the other run still open, the adapter offers it.
    await vi.waitFor(() => {
      expect(offered).toEqual([theirRun.runId]);
    });

    await theirRun.end({ reason: 'complete' });
  }, 30_000);

  it('a regenerate publishes a regenerate input and streams the new reply', async () => {
    const channelName = uniqueChannelName('ct-regen');

    const seen: VercelInput[] = [];
    let answers = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          seen.push(...input.inputs);
          answers += 1;
          const run = agent.openRun({ input });
          await run.pipe(replyStream(`a${String(answers)}`, answers === 1 ? 'first answer' : 'a different answer'));
          await run.end({ reason: 'complete' });
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const chat = new Chat<AI.UIMessage>({ id: channelName, transport: chatTransport });

    await chat.sendMessage({ text: 'what is the weather?' });
    expect(assistantText(chat)).toBe('first answer');

    // The user asks for another attempt, the way the AI SDK documents it: no
    // argument, meaning the last assistant message.
    const prompt = chat.messages.find((message) => message.role === 'user');
    await chat.regenerate();

    // The wire carried a regenerate anchored on the user turn, which is what
    // the truncated list ends with once useChat drops the assistant message it
    // is redoing. No copy of the conversation travels with it.
    expect(seen.at(-1)).toEqual({ kind: 'regenerate', payload: { messageId: prompt?.id } });
    expect(assistantText(chat)).toBe('a different answer');
  }, 30_000);

  it('an edited message wakes a fresh run', async () => {
    const channelName = uniqueChannelName('ct-edit');

    const runIds: string[] = [];
    const seen: VercelInput[] = [];
    let answers = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          seen.push(...input.inputs);
          answers += 1;
          const run = agent.openRun({ input });
          runIds.push(run.runId);
          await run.pipe(replyStream(`a${String(answers)}`, `answer ${String(answers)}`));
          await run.end({ reason: 'complete' });
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const chat = new Chat<AI.UIMessage>({ id: channelName, transport: chatTransport });

    await chat.sendMessage({ text: 'what is the wether?' });
    const typo = chat.messages.find((message) => message.role === 'user');
    expect(typo).toBeDefined();

    // The user fixes the typo. Passing the existing message id replaces that
    // message rather than appending, which is what an edit is.
    await chat.sendMessage({ text: 'what is the weather?', messageId: typo?.id });

    // Two distinct runs answered, so the edit did not re-enter the first one.
    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);

    // The agent saw the corrected text on the second turn, under the same
    // domain message id the typo had.
    const edited = seen.at(-1);
    expect(edited?.kind).toBe('message');
    expect(edited?.kind === 'message' && edited.payload.id).toBe(typo?.id);
    expect(edited?.kind === 'message' && edited.payload.parts).toEqual([
      { type: 'text', text: 'what is the weather?' },
    ]);
    expect(assistantText(chat)).toBe('answer 2');
  }, 30_000);

  it('a refresh mid-stream reads its store serial and resumes the run', async () => {
    const channelName = uniqueChannelName('ct-refresh');

    // A run that stays open, so it is genuinely in flight across the refresh.
    let source: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;
    let piped: Promise<unknown> | undefined;
    let inFlight: ReturnType<AgentTransport<VercelInput, VercelOutput>['openRun']> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          inFlight = agent.openRun({ input });
          piped = inFlight.pipe(
            new ReadableStream<AI.UIMessageChunk>({
              start: (controller) => {
                source = controller;
                controller.enqueue({ type: 'start', messageId: 'a1' });
                controller.enqueue({ type: 'text-start', id: 't1' });
                controller.enqueue({ type: 'text-delta', id: 't1', delta: 'The weather in ' });
              },
            }),
          );
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const chat = new Chat<AI.UIMessage>({ id: channelName, transport: chatTransport });

    // The application records the serial of its own turn as it is delivered,
    // which is the watermark it would have stored before the reload.
    const own = createEventRecorder<VercelInput, VercelOutput>();
    transport.subscribe(own.record);

    const sending = chat.sendMessage({ text: 'what is the weather?' });

    // Wait on the subscription rather than a clock, and wait for a delta
    // rather than any output: the message opens on its first delivery and the
    // text arrives on a later append, so only a delta proves the first half is
    // on the channel.
    await own.waitFor((all) => all.some((e) => e.kind === 'message' && e.outputs.some((o) => o.type === 'text-delta')));

    const ownTurn = await own.waitForEvent((e) => e.kind === 'message' && e.inputs.length > 0);
    const storedSerial = ownTurn.kind === 'message' ? ownTurn.meta.serial : undefined;
    expect(storedSerial).toBeTypeOf('string');

    // ---- the page reloads --------------------------------------------------
    const reloaded = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await reloaded.connect();
    const reloadedChatTransport = createChatTransport({ transport: reloaded, channelName });
    closeAfterTest(reloaded, reloadedChatTransport);

    // Everything at or before the store's serial is the store's to report, and
    // the in-flight run is withheld for the resume.
    const { messages } = await reloadedChatTransport.readSince(storedSerial);
    expect(messages).toEqual([]);

    const afterRefresh = new Chat<AI.UIMessage>({ id: channelName, transport: reloadedChatTransport });
    const resuming = afterRefresh.resumeStream();

    // The rest of the reply arrives live on the resumed stream, and the replay
    // gave it the half it missed.
    source?.enqueue({ type: 'text-delta', id: 't1', delta: 'Berlin is 4C' });
    source?.enqueue({ type: 'text-end', id: 't1' });
    source?.enqueue({ type: 'finish', finishReason: 'stop' });
    source?.close();
    await piped;
    await inFlight?.end({ reason: 'complete' });
    await Promise.all([resuming, sending]);

    // One message, not a duplicated prefix: the replay and the live tail were
    // joined into a single assistant turn.
    expect(assistantText(afterRefresh)).toBe('The weather in Berlin is 4C');
    expect(afterRefresh.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  }, 30_000);

  it('a superseded step attempt errors the stream, and the repair replays the winner', async () => {
    const channelName = uniqueChannelName('ct-supersede');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };

        // Attempt one. It publishes half its output under step s1, then the
        // process is gone: no step end, no run end.
        const dying = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(dying);
        await dying.connect();
        const input = await dying.locateInput(eventId);
        if (input) {
          const first = dying.openRun({ input, runId: 'run-retried' });
          await first.createStep({ stepId: 's1' }).pipe(replyStream('a1', 'half a rep'));
          dying.close();

          // Attempt two, in a fresh process. It re-enters the same run and
          // re-attempts the same step, so its output supersedes attempt one's.
          const retry = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
          closeAfterTest(retry);
          await retry.connect();
          const second = retry.adoptRun('run-retried');
          const attempt = second.createStep({ stepId: 's1' });
          await attempt.pipe(replyStream('a1', 'the whole reply'));
          await attempt.end();
          await second.end({ reason: 'complete' });
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const errors: Error[] = [];
    const chat = new Chat<AI.UIMessage>({
      id: channelName,
      transport: chatTransport,
      onError: (error) => errors.push(error),
    });

    // The stream cannot be repaired in place, because parts accumulate and no
    // chunk removes one. So it errors, and useChat reports that.
    await chat.sendMessage({ text: 'hello' });
    expect(chat.status).toBe('error');
    expect(errors.at(0)).toBeErrorInfoWithCode(ErrorCode.Conflict);

    // The consumer's repair: drop the damaged message and resume. The adapter
    // kept the run's events, and the two-pass filter over the replay keeps only
    // the attempt whose step-start serial won.
    chat.messages = chat.messages.filter((message) => message.role !== 'assistant');
    await chat.resumeStream();

    expect(assistantText(chat)).toBe('the whole reply');
  }, 30_000);

  it('reads a finished conversation out of history', async () => {
    const channelName = uniqueChannelName('ct-history');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          const run = agent.openRun({ input });
          await run.pipe(replyStream('asst-1', 'first answer'));
          await run.end({ reason: 'complete' });
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);
    const chat = new Chat<AI.UIMessage>({ id: channelName, transport: chatTransport });
    await chat.sendMessage({ text: 'first question' });

    // A second client arrives with an empty store and reads the whole channel.
    // An application calls readSince itself; useChat has no equivalent.
    const reader = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await reader.connect();
    const readerChatTransport = createChatTransport({ transport: reader, channelName });
    closeAfterTest(reader, readerChatTransport);

    const { messages } = await readerChatTransport.readSince();

    // Both sides come back, and the run has ended so nothing is withheld.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.events.every((event) => event.direction === 'input')).toBe(true);
    expect(messages[1]?.events.map((event) => event.event)).toContainEqual(
      expect.objectContaining({ type: 'text-delta', delta: 'first answer' }),
    );
    // eslint-disable-next-line unicorn/no-null -- the SDK contract is null
    expect(await readerChatTransport.reconnectToStream({ chatId: channelName })).toBe(null);
  }, 30_000);

  it('withholds an in-flight run from the history read and resumes it, replay then live', async () => {
    const channelName = uniqueChannelName('ct-resume');

    // One pipe whose source the test feeds by hand, so the run is genuinely
    // mid-stream when the second client arrives. A run publishes one message
    // per pipe, so a single message's halves have to come from one source.
    let source: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;
    let piped: Promise<unknown> | undefined;
    let inFlight: ReturnType<AgentTransport<VercelInput, VercelOutput>['openRun']> | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        const agent = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        closeAfterTest(agent);
        await agent.connect();
        const input = await agent.locateInput(eventId);
        if (input) {
          inFlight = agent.openRun({ input });
          // Not awaited: the pipe stays open, so the run is still in flight
          // when the route answers, which is the case under test.
          piped = inFlight.pipe(
            new ReadableStream<AI.UIMessageChunk>({
              start: (controller) => {
                source = controller;
                controller.enqueue({ type: 'start', messageId: 'asst-1' });
                controller.enqueue({ type: 'text-start', id: 't1' });
                controller.enqueue({ type: 'text-delta', id: 't1', delta: 'The weather in ' });
              },
            }),
          );
        }
        return new Response('', { status: 202 });
      }),
    );

    const transport = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await transport.connect();
    const chatTransport = createChatTransport({ transport, channelName });
    closeAfterTest(transport, chatTransport);

    // Driven through the adapter rather than a Chat, because the subject here
    // is the chunk stream's shape: one opener across the replay-then-live
    // join. A Chat would assemble that away, and the refresh test above
    // already asserts the assembled result.
    const sent = await chatTransport.sendMessages({
      trigger: 'submit-message',
      chatId: channelName,
      messageId: undefined,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is the weather?' }] }],
      abortSignal: undefined,
    });

    const firstChunks: AI.UIMessageChunk[] = [];
    const firstDone = readInto(sent, firstChunks);

    const own = createEventRecorder<VercelInput, VercelOutput>();
    transport.subscribe(own.record);
    await own.waitFor((all) => all.some((e) => e.kind === 'message' && e.outputs.some((o) => o.type === 'text-delta')));

    // A second client hydrates against an empty store: read, then resume.
    const reader = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await reader.connect();
    const readerChatTransport = createChatTransport({ transport: reader, channelName });
    closeAfterTest(reader, readerChatTransport);

    const { messages } = await readerChatTransport.readSince();
    // The assistant message belongs to a run with no end, so the history read
    // withholds it and the stream is its only producer. Only the client's own
    // turn is reported, and every event in it is an input.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.events.every((event) => event.direction === 'input')).toBe(true);

    const resumed = await readerChatTransport.reconnectToStream({ chatId: channelName });
    expect(resumed).not.toBeNull();

    // Finish the reply on the same pipe, then end the run.
    source?.enqueue({ type: 'text-delta', id: 't1', delta: 'Berlin is 4C' });
    source?.enqueue({ type: 'text-end', id: 't1' });
    source?.enqueue({ type: 'finish', finishReason: 'stop' });
    source?.close();
    await piped;
    await inFlight?.end({ reason: 'complete' });

    const [resumedChunks] = await Promise.all([drain(resumed as ReadableStream<AI.UIMessageChunk>), firstDone]);

    // The replay carried the withheld first half and the live subscription the
    // rest, in one stream with a single opener, so useChat builds one message.
    expect(textOf(resumedChunks)).toBe('The weather in Berlin is 4C');
    expect(resumedChunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
  }, 30_000);
});
