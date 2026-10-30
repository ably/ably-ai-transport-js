/**
 * The useChat transport over a real Ably channel.
 *
 * An agent pipes a turn with the Vercel codec, a stubbed `fetch` stands in
 * for the application's backend, and the chat transport hands `useChat` what
 * it reads. The platform is what makes these worth running: history only
 * reaches back from where a channel attached, the first append after an
 * attach arrives as the full text so far, and a turn that starts after the
 * transport attached is only ever seen live.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTransport, ErrorCode } from '../../../src/index.js';
import { createChatTransport, createVercelCodec, type VercelEvent } from '../../../src/vercel/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { drain } from '../../helper/streams.js';
import { streamOf } from '../../helper/test-codec.js';
import { controlledStream } from '../helpers.js';

const prompt: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Say hello.' }] };

/** A turn as `toUIMessageStream` writes it. */
const turn: AI.UIMessageChunk[] = [
  { type: 'start', messageId: 'msg_1' },
  { type: 'text-start', id: 'txt_1' },
  { type: 'text-delta', id: 'txt_1', delta: 'Hel' },
  { type: 'text-delta', id: 'txt_1', delta: 'lo' },
  { type: 'text-end', id: 'txt_1' },
  { type: 'finish', finishReason: 'stop' },
];

/** The first three chunks of the turn: up to its first text delta. */
const opening = turn.slice(0, 3);
const rest = turn.slice(3);

/** A second turn, as the agent writes the reply to the next prompt. */
const next: AI.UIMessageChunk[] = [
  { type: 'start', messageId: 'msg_2' },
  { type: 'text-start', id: 'txt_2' },
  { type: 'text-delta', id: 'txt_2', delta: 'Bye' },
  { type: 'text-end', id: 'txt_2' },
  { type: 'finish', finishReason: 'stop' },
];

/**
 * Resolves once `client` has received a text delta on the channel. A chat
 * transport reading the channel through the same client, subscribed before
 * this, has received it too by then.
 * @param client - The client to watch.
 * @param name - The channel name.
 * @returns Resolves on the first delta.
 */
const deltaReaches = async (client: Ably.Realtime, name: string): Promise<void> => {
  const channel = client.channels.get(name);
  const codec = createVercelCodec();
  await new Promise<void>((resolve) => {
    const listener = (message: Ably.InboundMessage): void => {
      if (!codec.decode(message).some((event) => event.type === 'text-delta')) return;
      channel.unsubscribe(listener);
      resolve();
    };
    // Not awaited: the listener is registered at once, and a failed attach
    // leaves the wait pending, which the test's timeout reports.
    void channel.subscribe(listener);
  });
};

describe('the useChat transport over Ably', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    closeAllClients();
  });

  it('posts a turn and streams the agent’s reply back off the channel', async () => {
    const name = uniqueChannelName('chat');
    const agent = createTransport({ client: ablyRealtimeClient(), channelName: name, codec: createVercelCodec() });
    const bodies: unknown[] = [];
    // A barrier, so the test ends after the agent does; its value is discarded.
    let replying: Promise<unknown> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      // CAST: the transport posts a JSON string.
      bodies.push(JSON.parse(init?.body as string));
      replying = agent.pipe(streamOf(...turn));
      return new Response(undefined, { status: 202 });
    });
    vi.stubGlobal('fetch', backend);
    const transport = createChatTransport({ client: ablyRealtimeClient(), channelName: name });

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: name,
      messageId: undefined,
      messages: [prompt],
      abortSignal: undefined,
    });

    expect(await drain(stream)).toEqual(turn);
    await replying;
    expect(bodies).toEqual([{ chatId: name, trigger: 'submit-message', messages: [prompt] }]);
    transport.close();
  });

  it('rejoins a reply in flight from its start when a tab opens mid-reply', async () => {
    const name = uniqueChannelName('chat');
    const agent = createTransport({ client: ablyRealtimeClient(), channelName: name, codec: createVercelCodec() });
    const observer = ablyRealtimeClient();
    const reached = deltaReaches(observer, name);
    await observer.channels.get(name).whenState('attached');
    const source = controlledStream<VercelEvent>();
    const replying = agent.pipe(source.source);
    for (const chunk of opening) source.push(chunk);
    await reached;

    const transport = createChatTransport({ client: ablyRealtimeClient(), channelName: name });
    const stream = await transport.reconnectToStream({ chatId: name });
    for (const chunk of rest) source.push(chunk);
    source.finish();

    expect(await drain(stream)).toEqual(turn);
    await replying;
    transport.close();
  });

  it('rejoins a turn that starts after the transport began reading, which only live delivery shows', async () => {
    const name = uniqueChannelName('chat');
    const client = ablyRealtimeClient();
    const transport = createChatTransport({ client, channelName: name });
    // Mounting with nothing running: the transport attaches and keeps reading.
    expect(await transport.reconnectToStream({ chatId: name })).toBeNull();

    const reached = deltaReaches(client, name);
    await client.channels.get(name).whenState('attached');
    const agent = createTransport({ client: ablyRealtimeClient(), channelName: name, codec: createVercelCodec() });
    const source = controlledStream<VercelEvent>();
    const replying = agent.pipe(source.source);
    for (const chunk of opening) source.push(chunk);
    await reached;

    const stream = await transport.reconnectToStream({ chatId: name });
    for (const chunk of rest) source.push(chunk);
    source.finish();

    expect(await drain(stream)).toEqual(turn);
    await replying;
    transport.close();
  });

  it('rejoins the turn a backend names by the serial of its prompt', async () => {
    const name = uniqueChannelName('chat');
    const agent = createTransport({ client: ablyRealtimeClient(), channelName: name, codec: createVercelCodec() });
    const observer = ablyRealtimeClient();
    const reached = deltaReaches(observer, name);
    await observer.channels.get(name).whenState('attached');
    // The backend publishes the prompt and records its serial with the turn.
    const { serial: from } = await agent.send({ type: 'user-message', message: prompt });
    expect(from).toBeDefined();
    const source = controlledStream<VercelEvent>();
    const replying = agent.pipe(source.source);
    for (const chunk of opening) source.push(chunk);
    await reached;

    const transport = createChatTransport({
      client: ablyRealtimeClient(),
      channelName: name,
      // eslint-disable-next-line @typescript-eslint/require-await -- the backend's answer, already known
      activeTurn: async () => ({ from }),
    });
    const stream = await transport.reconnectToStream({ chatId: name });
    for (const chunk of rest) source.push(chunk);
    source.finish();

    expect(await drain(stream)).toEqual(turn);
    await replying;
    transport.close();
  });

  it('follows the next turn when the backend names a prompt published after the latest turn began', async () => {
    const name = uniqueChannelName('chat');
    const agent = createTransport({ client: ablyRealtimeClient(), channelName: name, codec: createVercelCodec() });
    // An earlier turn has finished; the backend then publishes the next
    // prompt and records its serial before its agent starts.
    await agent.pipe(streamOf(...turn));
    const { serial: from } = await agent.send({ type: 'user-message', message: prompt });
    expect(from).toBeDefined();

    const transport = createChatTransport({
      client: ablyRealtimeClient(),
      channelName: name,
      // eslint-disable-next-line @typescript-eslint/require-await -- the backend's answer, already known
      activeTurn: async () => ({ from }),
    });
    const stream = await transport.reconnectToStream({ chatId: name });
    await agent.pipe(streamOf(...next));

    expect(await drain(stream)).toEqual(next);
    transport.close();
  });

  it('reads the channel again straight after close(), once the previous read has detached it', async () => {
    const name = uniqueChannelName('chat');
    const agent = createTransport({ client: ablyRealtimeClient(), channelName: name, codec: createVercelCodec() });
    // A barrier, so the test ends after the agent does; its value is discarded.
    let replying: Promise<unknown> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend = vi.fn(async (): Promise<Response> => {
      replying = agent.pipe(streamOf(...turn));
      return new Response(undefined, { status: 202 });
    });
    vi.stubGlobal('fetch', backend);
    const client = ablyRealtimeClient();
    const transport = createChatTransport({ client, channelName: name });
    // A StrictMode mount: rejoin, unmount, then the same transport again.
    expect(await transport.reconnectToStream({ chatId: name })).toBeNull();
    transport.close();

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: name,
      messageId: undefined,
      messages: [prompt],
      abortSignal: undefined,
    });

    expect(await drain(stream)).toEqual(turn);
    await replying;
    const channel = client.channels.get(name);
    expect(channel.state).toBe('attached');

    // The read it opened is kept: the next turn neither detaches nor attaches the channel.
    const changes: Ably.ChannelState[] = [];
    channel.on((change) => {
      changes.push(change.current);
    });
    const again = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: name,
      messageId: undefined,
      messages: [prompt],
      abortSignal: undefined,
    });
    expect(await drain(again)).toEqual(turn);
    await replying;
    expect(changes).toEqual([]);
    transport.close();
  });

  it('posts a turn sent straight after a stop once the stopped agent has ended its turn', async () => {
    const name = uniqueChannelName('chat');
    const agentClient = ablyRealtimeClient();
    const agent = createTransport({ client: agentClient, channelName: name, codec: createVercelCodec() });
    const cancelling = new AbortController();
    const agentChannel = agentClient.channels.get(name);
    await agentChannel.subscribe('cancel', () => {
      cancelling.abort();
    });
    const first = controlledStream<VercelEvent>();
    const order: string[] = [];
    let posts = 0;
    let replying: Promise<void> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend = vi.fn(async (): Promise<Response> => {
      posts += 1;
      order.push(`post ${String(posts)}`);
      replying =
        posts === 1
          ? (async (): Promise<void> => {
              try {
                await agent.pipe(first.source, { signal: cancelling.signal });
              } catch {
                order.push('abort');
                await agent.send({ type: 'abort' });
              }
            })()
          : (async (): Promise<void> => {
              await agent.pipe(streamOf(...next));
            })();
      return new Response(undefined, { status: 202 });
    });
    vi.stubGlobal('fetch', backend);
    const transport = createChatTransport({
      client: ablyRealtimeClient(),
      channelName: name,
      onStop: async ({ channel }) => {
        await channel.publish({ name: 'cancel', data: {} });
      },
    });
    const stop = new AbortController();
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: name,
      messageId: undefined,
      messages: [prompt],
      abortSignal: stop.signal,
    });
    for (const chunk of opening) first.push(chunk);
    const reader = stream.getReader();
    for (const chunk of opening) {
      const { value } = await reader.read();
      expect(value).toEqual(chunk);
    }

    // Stop, then regenerate at once, as a user can.
    stop.abort();
    const regenerated = await transport.sendMessages({
      trigger: 'regenerate-message',
      chatId: name,
      messageId: 'msg_1',
      messages: [prompt],
      abortSignal: undefined,
    });

    await expect(reader.read()).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    expect(await drain(regenerated)).toEqual(next);
    await replying;
    expect(order).toEqual(['post 1', 'abort', 'post 2']);
    transport.close();
  });

  it('stops a reply through onStop, publishing a cancel the agent hears on the channel', async () => {
    const name = uniqueChannelName('chat');
    const agentClient = ablyRealtimeClient();
    const agent = createTransport({ client: agentClient, channelName: name, codec: createVercelCodec() });
    const cancelling = new AbortController();
    // An agent with no address of its own listens for a cancel on the channel.
    const agentChannel = agentClient.channels.get(name);
    const heard = new Promise<void>((resolve) => {
      // Not awaited: the listener is registered at once, and the attach is
      // awaited on the next line.
      void agentChannel.subscribe('cancel', () => {
        cancelling.abort();
        resolve();
      });
    });
    await agentChannel.whenState('attached');
    const source = controlledStream<VercelEvent>();
    let replying: Promise<void> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend = vi.fn(async (): Promise<Response> => {
      replying = (async (): Promise<void> => {
        try {
          await agent.pipe(source.source, { signal: cancelling.signal });
        } catch {
          await agent.send({ type: 'abort' });
        }
      })();
      return new Response(undefined, { status: 202 });
    });
    vi.stubGlobal('fetch', backend);
    const transport = createChatTransport({
      client: ablyRealtimeClient(),
      channelName: name,
      onStop: ({ channel }) => {
        // Not awaited, as a synchronous onStop cannot: a failed publish leaves
        // `heard` pending, which the test's timeout reports.
        void channel.publish({ name: 'cancel', data: {} });
      },
    });
    const stop = new AbortController();

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: name,
      messageId: undefined,
      messages: [prompt],
      abortSignal: stop.signal,
    });
    for (const chunk of opening) source.push(chunk);
    const reader = stream.getReader();
    for (const chunk of opening) {
      const { value } = await reader.read();
      expect(value).toEqual(chunk);
    }
    stop.abort();

    await heard;
    await replying;
    await expect(reader.read()).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
    transport.close();
  });
});
