/**
 * The AG-UI agent over a real Ably channel.
 *
 * A `fetch` stands in for the application's backend: it takes the run's
 * `RunAgentInput` and has an agent pipe the run through `agUiAdaptor` on a
 * connection of its own, with the run's prompt in `RUN_STARTED`'s input. The
 * agent in the browser reads the run off the thread's channel, and AG-UI's own
 * reducer folds it into the agent's messages. A second tab joins a run in progress with the developer's own
 * `connect()`. The platform is what makes these worth running: each run
 * attaches the channel and detaches it again, a detach takes a round trip,
 * and the next read must not attach before it lands; a join's history
 * reaches back only from where the channel attached; and the first append
 * after an attach arrives as the full text so far.
 */

import type * as Ably from '@ably/pubsub-core';
import type * as AGUI from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { createAblyAgent } from '../../../src/ag-ui/client/index.js';
import { agUiAdaptor, agUiDecoder } from '../../../src/ag-ui/index.js';
import type { PipeResult } from '../../../src/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { closeAllClients, pubsubClient } from '../../helper/pubsub-client.js';
import { streamOf } from '../../helper/streams.js';
import { controlledStream } from '../helpers.js';

const prompt: AGUI.Message = { id: 'u1', role: 'user', content: 'Say hello.' };

/**
 * A run that answers in text: `RUN_STARTED` with the run's prompt in its
 * input, one text message streamed in `deltas`, and `RUN_FINISHED`.
 * @param input - The run's input, as the backend received it.
 * @param deltas - The reply, as the deltas that stream it.
 * @returns The run's events.
 */
const textRun = (input: AGUI.RunAgentInput, deltas: string[]): AGUI.Event[] => {
  const { threadId, runId } = input;
  const messageId = `reply-${runId}`;
  // The user message that started the run, the last one the tab sent.
  const started = input.messages.slice(-1);
  return [
    { type: EventType.RUN_STARTED, threadId, runId, input: { ...input, messages: started } },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    ...deltas.map((delta): AGUI.Event => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })),
    { type: EventType.TEXT_MESSAGE_END, messageId },
    { type: EventType.RUN_FINISHED, threadId, runId },
  ];
};

/**
 * The reply a text run leaves on an agent, as AG-UI's reducer builds it.
 * @param runId - The run.
 * @param text - The reply's text.
 * @returns The message.
 */
const replyMessage = (runId: string, text: string): AGUI.Message => ({
  id: `reply-${runId}`,
  role: 'assistant',
  content: text,
});

/**
 * The input a backend call posted.
 * @param init - The request.
 * @returns The run's input.
 */
const inputOf = (init: RequestInit): AGUI.RunAgentInput =>
  // CAST: the agent posts a JSON string, as HttpAgent does.
  JSON.parse(init.body as string) as AGUI.RunAgentInput;

/**
 * Watch `channel` for a text delta. Resolves once the channel is attached,
 * so a delta published after that reaches the watch.
 * @param channel - The channel to watch, on a connection of its own.
 * @returns The wait for the first delta, which resolves when one arrives.
 */
const watchForDelta = async (channel: Ably.RealtimeChannel): Promise<{ reached: Promise<void> }> => {
  const decoder = agUiDecoder();
  const delta: { arrived?: () => void } = {};
  const reached = new Promise<void>((resolve) => {
    delta.arrived = resolve;
  });
  const listener = (message: Ably.InboundMessage): void => {
    if (!decoder.decode(message).some(({ event }) => event?.type === EventType.TEXT_MESSAGE_CONTENT)) return;
    channel.unsubscribe(listener);
    delta.arrived?.();
  };
  await channel.subscribe(listener);
  return { reached };
};

/**
 * The developer's own join of a run in progress, for an agent's `connect()`:
 * the thread's events after the serial its store holds, from the channel's
 * history and then live, to the end of the run in progress. `untilAttach`
 * history ends where the channel attached, so a channel an earlier run left
 * attached is detached first. It subscribes through a decoder of its own,
 * which attaches the channel, and holds what arrives live while it reads
 * history back to the serial. When `signal` aborts, as `abortRun()` aborts
 * the agent's `abortController`, it ends the run in this tab with
 * `RUN_ERROR` and the code `abort`, as the agent ends a run it sent. Either
 * way it unsubscribes and completes, and leaves the channel attached.
 * @param channel - The thread's channel.
 * @param serial - The serial of the last run the store holds; absent for a thread it holds no run of.
 * @param signal - The join's own abort signal.
 * @returns The events, for AG-UI to apply.
 */
const readRunsAfter = (
  channel: Ably.RealtimeChannel,
  serial?: string,
  signal?: AbortSignal,
): Observable<AGUI.BaseEvent> =>
  new Observable<AGUI.BaseEvent>((subscriber) => {
    const decoder = agUiDecoder();
    const held: Ably.InboundMessage[] = [];
    let live = false;
    let inRun = false;
    let ending = false;
    const listener = (message: Ably.InboundMessage): void => {
      if (live) apply(message);
      else held.push(message);
    };
    const stop = (): void => {
      ending = true;
      channel.unsubscribe(listener);
    };
    const isEnding = (): boolean => ending;
    const end = (): void => {
      if (ending) return;
      stop();
      subscriber.complete();
    };
    const apply = (message: Ably.InboundMessage): void => {
      for (const { event } of decoder.decode(message)) {
        if (event === undefined || ending) continue;
        if (event.type === EventType.RUN_STARTED) inRun = true;
        subscriber.next(event);
        if (event.type !== EventType.RUN_FINISHED && event.type !== EventType.RUN_ERROR) continue;
        inRun = false;
        if (live) end();
      }
    };
    const join = async (): Promise<void> => {
      if (channel.state === 'attached') await channel.detach();
      await channel.subscribe(listener);
      // An abort during the detach or the subscribe has already ended the
      // join, before this listener was added.
      if (isEnding()) {
        channel.unsubscribe(listener);
        return;
      }
      const newestFirst: Ably.InboundMessage[] = [];
      let page = await channel.history({ untilAttach: true });
      paging: for (;;) {
        for (const message of page.items) {
          if (serial !== undefined && message.serial !== undefined && message.serial <= serial) break paging;
          newestFirst.push(message);
        }
        if (!page.hasNext()) break;
        const next = await page.next();
        if (next === null) break;
        page = next;
      }
      for (const message of newestFirst.toReversed()) apply(message);
      live = true;
      for (const message of held) apply(message);
      if (!inRun) end();
    };
    const onAbort = (): void => {
      if (ending) return;
      if (inRun) subscriber.next({ type: EventType.RUN_ERROR, message: 'Join aborted', code: 'abort' });
      end();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Not awaited: the subscribe function returns at once, and a failure
    // fails the join through its subscriber.
    join().catch((error: unknown) => {
      subscriber.error(error);
    });
    return () => {
      signal?.removeEventListener('abort', onAbort);
      stop();
    };
  });

/**
 * The text of the assistant messages an agent holds.
 * @param messages - The agent's messages.
 * @returns Each assistant message's text, in order.
 */
const replies = (messages: AGUI.Message[]): string[] =>
  messages.flatMap((message) =>
    message.role === 'assistant' && typeof message.content === 'string' ? [message.content] : [],
  );

describe('the AG-UI agent over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('posts a run and reads its events off the thread’s channel, which AG-UI’s reducer folds into the reply', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    const inputs: AGUI.RunAgentInput[] = [];
    let piping: Promise<unknown> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      inputs.push(input);
      const adaptor = agUiAdaptor(agentClient.channels.get(input.threadId));
      piping = adaptor.pipe(streamOf(...textRun(input, ['Hello ', 'there'])));
      return new Response(undefined, { status: 202 });
    };
    const browser = pubsubClient();
    const agent = createAblyAgent({
      url: '/api/agent',
      threadId,
      channel: browser.channels.get(threadId),
      fetch: backend,
    });

    agent.addMessage(prompt);
    const { newMessages } = await agent.runAgent();
    await piping;

    expect(inputs).toEqual([expect.objectContaining({ threadId, messages: [prompt] })]);
    // RUN_STARTED carries the prompt too, and AG-UI holds it once, by its id.
    expect(agent.messages).toEqual([prompt, replyMessage(inputs[0]?.runId ?? '', 'Hello there')]);
    expect(replies(newMessages)).toEqual(['Hello there']);
    // The run leaves the channel attached, for the application to detach.
    expect(browser.channels.get(threadId).state).toBe('attached');
  });

  it('runs two runs back to back on the channel the first run left attached', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    const piping: Promise<unknown>[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      const adaptor = agUiAdaptor(agentClient.channels.get(input.threadId));
      piping.push(adaptor.pipe(streamOf(...textRun(input, ['Hi', '!']))));
      return new Response(undefined, { status: 202 });
    };
    const browser = pubsubClient();
    const channel = browser.channels.get(threadId);
    const states: Ably.ChannelState[] = [];
    channel.on((change) => {
      states.push(change.current);
    });
    const agent = createAblyAgent({ url: '/api/agent', threadId, channel, fetch: backend });

    agent.addMessage(prompt);
    await agent.runAgent();
    agent.addMessage({ id: 'u2', role: 'user', content: 'Again.' });
    await agent.runAgent();
    await Promise.all(piping);

    expect(replies(agent.messages)).toEqual(['Hi!', 'Hi!']);
    expect(states).toEqual(['attaching', 'attached']);
  });

  it('attaches the channel only once a detach the application has in flight has finished', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    let piping: Promise<unknown> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      const adaptor = agUiAdaptor(agentClient.channels.get(input.threadId));
      piping = adaptor.pipe(streamOf(...textRun(input, ['Hello ', 'there'])));
      return new Response(undefined, { status: 202 });
    };
    const browser = pubsubClient();
    const channel = browser.channels.get(threadId);
    await channel.attach();
    const agent = createAblyAgent({ url: '/api/agent', threadId, channel, fetch: backend });

    // The application lets the channel go, and the tab sends at once.
    const detaching = channel.detach();
    expect(channel.state).toBe('detaching');
    agent.addMessage(prompt);
    await agent.runAgent();
    await detaching;
    await piping;

    expect(replies(agent.messages)).toEqual(['Hello there']);
  });

  it('attaches a channel that subscribing does not attach, as under <ChannelProvider>', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    let piping: Promise<unknown> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      const adaptor = agUiAdaptor(agentClient.channels.get(input.threadId));
      piping = adaptor.pipe(streamOf(...textRun(input, ['Hello ', 'there'])));
      return new Response(undefined, { status: 202 });
    };
    const browser = pubsubClient();
    const channel = browser.channels.get(threadId, { attachOnSubscribe: false });
    const agent = createAblyAgent({ url: '/api/agent', threadId, channel, fetch: backend });

    agent.addMessage(prompt);
    await agent.runAgent();
    await piping;

    expect(replies(agent.messages)).toEqual(['Hello there']);
  });

  it('shows another tab’s prompt in a tab that joins the run through its own connect(), after its own run left the channel attached', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    const adaptor = agUiAdaptor(agentClient.channels.get(threadId));
    const source = controlledStream<AGUI.Event>();
    const pipes: Promise<PipeResult>[] = [];
    let second: AGUI.Event[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      if (pipes.length === 0) {
        pipes.push(adaptor.pipe(streamOf(...textRun(input, ['Hello ', 'there']))));
      } else {
        // The second run streams as the test feeds it.
        second = textRun(input, ['Bye', ' for', ' now']);
        pipes.push(adaptor.pipe(source.source));
        for (const event of second.slice(0, 3)) source.push(event);
      }
      return new Response(undefined, { status: 202 });
    };
    // This tab sends the first run, which leaves its channel attached.
    const joiningBrowser = pubsubClient();
    const joiningChannel = joiningBrowser.channels.get(threadId);
    const joining = createAblyAgent({ url: '/api/agent', threadId, channel: joiningChannel, fetch: backend });
    joining.addMessage(prompt);
    await joining.runAgent();
    // The developer's store holds the first run, with the serial its pipe resolved with.
    const first = await pipes[0];
    const stored = { messages: [...joining.messages], serial: first?.serial };

    // Another tab sends the second run.
    const sendingBrowser = pubsubClient();
    const sending = createAblyAgent({
      url: '/api/agent',
      threadId,
      channel: sendingBrowser.channels.get(threadId),
      fetch: backend,
    });
    const nextPrompt: AGUI.Message = { id: 'u2', role: 'user', content: 'And bye?' };
    sending.addMessage(nextPrompt);
    const { reached } = await watchForDelta(pubsubClient().channels.get(threadId));
    const running = sending.runAgent();
    await reached;

    // connect() is protected in AG-UI's types, so the join is assigned over it.
    Object.assign(joining, { connect: () => readRunsAfter(joiningChannel, stored.serial) });
    const joined = joining.connectAgent();
    // The join detaches the channel its run left attached, then attaches it again.
    await joiningChannel.whenState('detached');
    await joiningChannel.whenState('attached');
    for (const event of second.slice(3)) source.push(event);
    source.finish();

    await Promise.all([running, joined]);
    await Promise.all(pipes);
    const runId = second[0]?.type === EventType.RUN_STARTED ? second[0].runId : '';
    const secondReply = replyMessage(runId, 'Bye for now');
    expect(joining.messages).toEqual([...stored.messages, nextPrompt, secondReply]);
    expect(sending.messages).toEqual([nextPrompt, secondReply]);
  });

  it('ends the run in the tab that stops it at once, while a tab that joined it reads on to the end the cancel brings about', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    const agentChannel = agentClient.channels.get(threadId);
    const adaptor = agUiAdaptor(agentChannel);
    // The developer's agent watches the thread's channel for a cancel, as an
    // agent with no address of its own does.
    const cancelling = new AbortController();
    await agentChannel.subscribe('cancel', () => {
      cancelling.abort();
    });
    const source = controlledStream<AGUI.Event>();
    let run: AGUI.Event[] = [];
    let running: Promise<void> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      run = textRun(input, ['Hel', 'lo']);
      running = (async (): Promise<void> => {
        try {
          await adaptor.pipe(source.source, { signal: cancelling.signal });
        } catch {
          // Cancelled: close the open text message, then end the run as cancelled.
          await adaptor.send({ type: EventType.TEXT_MESSAGE_END, messageId: `reply-${input.runId}` });
          await adaptor.send({
            type: EventType.RUN_FINISHED,
            threadId,
            runId: input.runId,
            outcome: { type: 'cancelled' },
          });
        }
      })();
      for (const event of run.slice(0, 3)) source.push(event);
      return new Response(undefined, { status: 202 });
    };
    // The developer's cancel endpoint publishes the cancel from the
    // backend's own connection.
    const cancelEndpoint = async (cancel: { threadId: string; runId: string }): Promise<void> => {
      await agentClient.channels.get(cancel.threadId).publish({ name: 'cancel', data: { runId: cancel.runId } });
    };
    const cancels: { threadId: string; runId: string }[] = [];
    const sendingBrowser = pubsubClient();
    const sending = createAblyAgent({
      url: '/api/agent',
      threadId,
      channel: sendingBrowser.channels.get(threadId),
      fetch: backend,
    });
    let cancelled: Promise<void> = Promise.resolve();
    let stopRun: string | undefined;
    sending.subscribe({
      onRunInitialized: ({ input }) => {
        stopRun = input.runId;
      },
      onRunStartedEvent: ({ event }) => {
        stopRun = event.runId;
      },
      onRunErrorEvent: ({ event }) => {
        if (event.code !== 'abort' || stopRun === undefined) return;
        const cancel = { threadId: sending.threadId, runId: stopRun };
        cancels.push(cancel);
        cancelled = cancelEndpoint(cancel);
      },
    });
    sending.addMessage(prompt);
    const { reached } = await watchForDelta(pubsubClient().channels.get(threadId));
    const stoppedRun = sending.runAgent({ runId: 'r1' });
    await reached;
    const joiningBrowser = pubsubClient();
    const joiningChannel = joiningBrowser.channels.get(threadId);
    const joining = createAblyAgent({ url: '/api/agent', threadId, channel: joiningChannel });
    Object.assign(joining, { connect: () => readRunsAfter(joiningChannel) });
    const outcomes: string[] = [];
    const joined = joining.connectAgent(undefined, {
      onRunFinishedEvent: ({ outcome }) => {
        outcomes.push(outcome);
      },
    });
    await joiningChannel.whenState('attached');
    // One more delta once the joining tab is attached: it arrives there as the
    // text so far, whatever history held at the attach.
    const { reached: nextDelta } = await watchForDelta(pubsubClient().channels.get(threadId));
    for (const event of run.slice(3, 4)) source.push(event);
    await nextDelta;

    sending.abortRun();
    await stoppedRun;
    expect(cancels).toEqual([{ threadId, runId: 'r1' }]);

    await cancelled;
    await joined;
    await running;
    expect(outcomes).toEqual(['cancelled']);
    expect(joining.messages).toEqual([prompt, replyMessage('r1', 'Hello')]);
  });

  it('stops the run from a tab that joined it, whose cancel brings the run’s end to the tab that sent it', async () => {
    const threadId = uniqueChannelName('ag-ui-agent');
    const agentClient = pubsubClient();
    const agentChannel = agentClient.channels.get(threadId);
    const adaptor = agUiAdaptor(agentChannel);
    const cancelling = new AbortController();
    await agentChannel.subscribe('cancel', () => {
      cancelling.abort();
    });
    const source = controlledStream<AGUI.Event>();
    let running: Promise<void> = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once and runs the agent beside the response
    const backend: AGUI.HttpAgentFetchFn = async (_url, init) => {
      const input = inputOf(init);
      running = (async (): Promise<void> => {
        try {
          await adaptor.pipe(source.source, { signal: cancelling.signal });
        } catch {
          // Cancelled: close the open text message, then end the run as cancelled.
          await adaptor.send({ type: EventType.TEXT_MESSAGE_END, messageId: `reply-${input.runId}` });
          await adaptor.send({
            type: EventType.RUN_FINISHED,
            threadId,
            runId: input.runId,
            outcome: { type: 'cancelled' },
          });
        }
      })();
      for (const event of textRun(input, ['Hel', 'lo']).slice(0, 3)) source.push(event);
      return new Response(undefined, { status: 202 });
    };
    const cancelEndpoint = async (cancel: { threadId: string; runId: string }): Promise<void> => {
      await agentClient.channels.get(cancel.threadId).publish({ name: 'cancel', data: { runId: cancel.runId } });
    };
    const sendingBrowser = pubsubClient();
    const sending = createAblyAgent({
      url: '/api/agent',
      threadId,
      channel: sendingBrowser.channels.get(threadId),
      fetch: backend,
    });
    sending.addMessage(prompt);
    const { reached } = await watchForDelta(pubsubClient().channels.get(threadId));
    const outcomes: string[] = [];
    const sent = sending.runAgent(
      { runId: 'r1' },
      {
        onRunFinishedEvent: ({ outcome }) => {
          outcomes.push(outcome);
        },
      },
    );
    await reached;

    const joiningBrowser = pubsubClient();
    const joiningChannel = joiningBrowser.channels.get(threadId);
    const joining = createAblyAgent({ url: '/api/agent', threadId, channel: joiningChannel });
    const cancels: { threadId: string; runId: string }[] = [];
    let cancelled: Promise<void> = Promise.resolve();
    let stopRun: string | undefined;
    const runStarted: { reached?: () => void } = {};
    const joinedRun = new Promise<void>((resolve) => {
      runStarted.reached = resolve;
    });
    joining.subscribe({
      onRunInitialized: ({ input }) => {
        stopRun = input.runId;
      },
      onRunStartedEvent: ({ event }) => {
        stopRun = event.runId;
        runStarted.reached?.();
      },
      onRunErrorEvent: ({ event }) => {
        if (event.code !== 'abort' || stopRun === undefined) return;
        const cancel = { threadId: joining.threadId, runId: stopRun };
        cancels.push(cancel);
        cancelled = cancelEndpoint(cancel);
      },
    });
    // The join reads under a controller of its own, which abortRun() aborts.
    joining.abortController = new AbortController();
    const { signal } = joining.abortController;
    Object.assign(joining, { connect: () => readRunsAfter(joiningChannel, undefined, signal) });
    const joined = joining.connectAgent();
    await joinedRun;

    joining.abortRun();
    await joined;
    expect(cancels).toEqual([{ threadId, runId: 'r1' }]);

    await cancelled;
    await sent;
    await running;
    expect(outcomes).toEqual(['cancelled']);
    expect(sending.messages).toEqual([prompt, replyMessage('r1', 'Hel')]);
  });
});
