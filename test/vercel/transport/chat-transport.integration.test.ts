/**
 * Chat-transport integration tests over a real Ably channel.
 *
 * The unit suite drives the adapter against a fake that hands back
 * pre-classified events and a canned `history()`. These tests prove the parts
 * only a real channel can: that the agent's `ai-run-start` carries the header
 * the client matches its own publish against, that backwards paging bounded at
 * the attach point reaches what the walk needs, and that the join between the
 * walk and the live subscription hands each message to exactly one producer.
 *
 * The chain is the shipped one end to end:
 *
 *   ChatTransport → ClientTransport → Ably → AgentTransport → run.pipe
 *
 * The `fetch` stub stands in for the application's chat route, and it attaches
 * a fresh agent transport per request. That is not a convenience: `history()`
 * pages backwards from the attach point, so a long-lived agent attached before
 * the client published can never locate that input. A route that attaches per
 * request has its attach point after the input, which is what the design means
 * by "a route that attaches per request has to find the input already on the
 * channel when it gets there".
 *
 * Nothing about the run travels back over HTTP: the client resolves the run id
 * off the channel by matching `input-transport-message-id` on `ai-run-start`.
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentTransport, ClientTransport, LocatedInput } from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createAgentTransport, createClientTransport } from '../../../src/vercel/transport/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { drain } from '../../helper/streams.js';

/** What a route hands back so a test can drive the run it opened. */
interface OpenedRun {
  /** The run the route opened from the located input. */
  run: ReturnType<AgentTransport<VercelInput, VercelOutput>['openRun']>;
  /** The per-request agent transport, closed in teardown. */
  transport: AgentTransport<VercelInput, VercelOutput>;
}

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
 * The text a chunk sequence carries, concatenated in wire order.
 * @param chunks - The chunks to read.
 * @returns The concatenated text deltas.
 */
const textOf = (chunks: AI.UIMessageChunk[]): string =>
  chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => ('delta' in chunk && typeof chunk.delta === 'string' ? chunk.delta : ''))
    .join('');

/**
 * A user message.
 * @param id - The message's domain id.
 * @param text - Its text.
 * @returns The message.
 */
const userMessage = (id: string, text: string): AI.UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/**
 * The options useChat would pass for a fresh send.
 * @param channelName - The conversation's channel, which is also the chat id.
 * @param messages - The message list at send time.
 * @returns The send options.
 */
const submit = (channelName: string, messages: AI.UIMessage[]): Parameters<ChatTransport['sendMessages']>[0] => ({
  trigger: 'submit-message',
  chatId: channelName,
  messageId: undefined,
  messages,
  abortSignal: undefined,
});

describe('chat transport over a real channel', () => {
  const routeTransports: AgentTransport<VercelInput, VercelOutput>[] = [];
  let client: ClientTransport<VercelInput, VercelOutput> | undefined;
  let chat: ChatTransport | undefined;
  let observer: ClientTransport<VercelInput, VercelOutput> | undefined;
  let observerChat: ChatTransport | undefined;

  afterEach(() => {
    observerChat?.close();
    observerChat = undefined;
    observer?.close();
    observer = undefined;
    chat?.close();
    chat = undefined;
    client?.close();
    client = undefined;
    for (const transport of routeTransports.splice(0)) transport.close();
    closeAllClients();
    vi.unstubAllGlobals();
  });

  /**
   * Stand the client up and stub the chat route.
   * @param channelName - The conversation's channel.
   * @param route - Called with the located input and the run the route opened for it.
   * @returns Resolves once the client is connected and the route is stubbed.
   */
  const wire = async (
    channelName: string,
    route: (located: LocatedInput<VercelInput>, opened: OpenedRun) => unknown,
  ): Promise<void> => {
    client = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await client.connect();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        const { eventId } = JSON.parse(init.body ?? '{}') as { eventId: string };
        // A fresh transport per request, as a serverless route would: its
        // attach point is after the input, so the backwards walk reaches it.
        const transport = createAgentTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
        routeTransports.push(transport);
        await transport.connect();
        const located = await transport.locateInput(eventId);
        // Awaited: `pipe` opens one implicit step per call and a second pipe
        // while the first's step is open throws, so the route finishes the
        // publishing it owns before answering.
        if (located) await route(located, { run: transport.openRun({ input: located }), transport });
        // The body carries nothing the client reads.
        return new Response('', { status: 202 });
      }),
    );

    chat = createChatTransport({ transport: client, channelName });
  };

  it('sends, learns the run id off the channel, streams the reply, and closes on the run end', async () => {
    const channelName = uniqueChannelName('ct-send');

    await wire(channelName, async (_located, { run }) => {
      await run.pipe(replyStream('asst-1', 'The weather in Berlin is 4C'));
      await run.end({ reason: 'complete' });
    });

    const stream = await chat?.sendMessages(submit(channelName, [userMessage('u1', 'what is the weather?')]));
    const chunks = await drain(stream as ReadableStream<AI.UIMessageChunk>);

    // Nothing in the test terminated the stream, so the run's own `ai-run-end`
    // did — which means the client learned the run id off the channel, because
    // a stream with no run id matches no terminal.
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'asst-1' });
    expect(textOf(chunks)).toBe('The weather in Berlin is 4C');
    expect(chat?.streaming).toBe(false);
  }, 30_000);

  it('walks a finished conversation out of history', async () => {
    const channelName = uniqueChannelName('ct-walk');

    await wire(channelName, async (_located, { run }) => {
      await run.pipe(replyStream('asst-1', 'first answer'));
      await run.end({ reason: 'complete' });
    });

    const stream = await chat?.sendMessages(submit(channelName, [userMessage('u1', 'first question')]));
    await drain(stream as ReadableStream<AI.UIMessageChunk>);

    // A second client arrives with an empty store and walks the whole channel.
    observer = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await observer.connect();
    observerChat = createChatTransport({ transport: observer, channelName });

    const { messages } = await observerChat.readSince();

    // Both sides come back, and the run has ended so nothing is withheld.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.events.every((walked) => walked.direction === 'input')).toBe(true);
    expect(messages[1]?.events.map((walked) => walked.event)).toContainEqual(
      expect.objectContaining({ type: 'text-delta', delta: 'first answer' }),
    );
    // eslint-disable-next-line unicorn/no-null -- the SDK contract is null
    expect(await observerChat.reconnectToStream({ chatId: channelName })).toBe(null);
  }, 30_000);

  it('withholds an in-flight run from the walk and resumes it, replay then live', async () => {
    const channelName = uniqueChannelName('ct-resume');

    // One pipe whose source the test feeds by hand, so the run is genuinely
    // mid-stream when the second client arrives. A run publishes one message
    // per pipe, so a single message's halves have to come from one source.
    let source: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;
    let piped: Promise<unknown> | undefined;
    let inFlight: OpenedRun | undefined;

    await wire(channelName, (_located, handles) => {
      inFlight = handles;
      piped = handles.run.pipe(
        new ReadableStream<AI.UIMessageChunk>({
          start: (controller) => {
            source = controller;
            controller.enqueue({ type: 'start', messageId: 'asst-1' });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'The weather in ' });
          },
        }),
      );
      // `piped` is deliberately not awaited here: the pipe stays open so the
      // run is still in flight when the route answers, which is the case under
      // test.
    });

    const firstStream = await chat?.sendMessages(submit(channelName, [userMessage('u1', 'what is the weather?')]));

    // Read the sender's stream in the background so the first half is provably
    // on the channel before the second client walks.
    const firstChunks: AI.UIMessageChunk[] = [];
    const firstDone = (async () => {
      const reader = (firstStream as ReadableStream<AI.UIMessageChunk>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        firstChunks.push(value);
      }
    })();
    await vi.waitFor(
      () => {
        expect(textOf(firstChunks)).toBe('The weather in ');
      },
      { timeout: 15_000 },
    );

    // A second client hydrates against an empty store: walk, then resume.
    observer = createClientTransport({ channel: ablyRealtimeClient().channels.get(channelName) });
    await observer.connect();
    observerChat = createChatTransport({ transport: observer, channelName });

    const { messages } = await observerChat.readSince();
    // The assistant message belongs to a run with no end, so the walk withholds
    // it and the stream is its only producer. Only the client's own turn is
    // reported, and every event in it is an input.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.events.every((walked) => walked.direction === 'input')).toBe(true);

    const resumed = await observerChat.reconnectToStream({ chatId: channelName });
    expect(resumed).not.toBeNull();

    // Finish the reply on the same pipe, then end the run.
    source?.enqueue({ type: 'text-delta', id: 't1', delta: 'Berlin is 4C' });
    source?.enqueue({ type: 'text-end', id: 't1' });
    source?.enqueue({ type: 'finish', finishReason: 'stop' });
    source?.close();
    await piped;
    await inFlight?.run.end({ reason: 'complete' });

    const [resumedChunks] = await Promise.all([drain(resumed as ReadableStream<AI.UIMessageChunk>), firstDone]);

    // The replay carried the withheld first half and the live subscription the
    // rest, in one stream with a single opener — so useChat builds one message.
    expect(textOf(resumedChunks)).toBe('The weather in Berlin is 4C');
    expect(resumedChunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
  }, 30_000);
});
