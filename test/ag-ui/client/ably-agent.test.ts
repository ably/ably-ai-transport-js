import * as Ably from '@ably/pubsub-core';
import * as AGUI from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import * as Rx from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { type AblyAgentOptions, createAblyAgent } from '../../../src/ag-ui/client/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel } from '../../../src/logger.js';
import { recordingLogger } from '../../helper/logger.js';
import { type ChannelFixture, channelWith, type Gate, gate } from '../../helper/read-channel.js';
import { nextMacrotask } from '../../helper/streams.js';
import { textRun, THREAD, wireOf, withPrompt } from './fixtures.js';

// AG-UI's own check of a run's outgoing input, watched, so a test can read
// the limit the agent passes it.
vi.mock('@ag-ui/client', async (importOriginal) => {
  const actual = await importOriginal<typeof AGUI>();
  return { ...actual, enforceOutgoingInput: vi.fn(actual.enforceOutgoingInput) };
});

/** The backend a test stands in for: `fetch`, answering every run at once. */
type Backend = Mock<AGUI.HttpAgentFetchFn>;

/**
 * A backend that answers every run with an empty 202, as one whose agent runs
 * past the response does.
 * @returns The backend.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once
const acceptingBackend = (): Backend => vi.fn(async () => new Response(undefined, { status: 202 }));

/**
 * An agent on the fixture's channel, posting to `backend`.
 * @param fixture - The thread's channel.
 * @param backend - The backend.
 * @param options - Options to add or override.
 * @returns The agent.
 */
const agentOn = (fixture: ChannelFixture, backend: Backend, options: Partial<AblyAgentOptions> = {}): AGUI.HttpAgent =>
  createAblyAgent({
    url: '/api/agent',
    threadId: THREAD,
    channel: fixture.channel,
    fetch: backend,
    ...options,
  });

/**
 * The `RunAgentInput` a backend call posted.
 * @param backend - The backend.
 * @param call - Which call, from 0.
 * @returns The posted input.
 */
const postedInput = (backend: Backend, call = 0): AGUI.RunAgentInput => {
  const init = backend.mock.calls[call]?.[1];
  // CAST: the agent posts a JSON string, as HttpAgent does.
  return JSON.parse(init?.body as string) as AGUI.RunAgentInput;
};

/**
 * The text of the assistant messages an agent holds.
 * @param messages - The agent's messages.
 * @returns Each assistant message's text, in order.
 */
const replies = (messages: AGUI.Message[]): string[] =>
  messages.flatMap((message) =>
    message.role === 'assistant' && typeof message.content === 'string' ? [message.content] : [],
  );

/**
 * An AG-UI subscriber that records the `RUN_ERROR` events AG-UI applies.
 * @returns The subscriber, and the events it recorded.
 */
const runErrors = (): { subscriber: AGUI.AgentSubscriber; events: AGUI.RunErrorEvent[] } => {
  const events: AGUI.RunErrorEvent[] = [];
  return {
    subscriber: {
      onRunErrorEvent: ({ event }) => {
        events.push(event);
      },
    },
    events,
  };
};

/**
 * Hold the fixture channel's next subscribe until the returned gate opens, so
 * the channel is not attached until then.
 * @param fixture - The thread's channel.
 * @returns The gate.
 */
const holdSubscribe = (fixture: ChannelFixture): Gate => {
  const subscribing = gate();
  fixture.channel.subscribe.mockImplementationOnce(async (listener) => {
    fixture.channel.listener = listener;
    await subscribing.promise;
    // eslint-disable-next-line unicorn/no-null -- ably-js resolves subscribe with null when the attach changed nothing
    return null;
  });
  return subscribing;
};

/**
 * Hold the fixture channel's next attach until the returned gate opens.
 * @param fixture - The thread's channel.
 * @returns The gate.
 */
const holdAttach = (fixture: ChannelFixture): Gate => {
  const attaching = gate();
  fixture.channel.attach.mockImplementationOnce(async () => {
    await attaching.promise;
    fixture.channel.state = 'attached';
    fixture.channel.emitStateChange({ current: 'attached', previous: 'attaching', resumed: false });
    // eslint-disable-next-line unicorn/no-null -- ably-js resolves attach with null when it changed nothing
    return null;
  });
  return attaching;
};

const prompt: AGUI.Message = { id: 'u1', role: 'user', content: 'Hello?' };
const reply = textRun('r1', 'm1', ['Hi ', 'there']);
const replyMessage: AGUI.Message = { id: 'm1', role: 'assistant', content: 'Hi there' };

describe('createAblyAgent', () => {
  beforeEach(() => {
    // AG-UI logs a failed run to the console before it rejects.
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silenced */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['no channel', undefined],
    ['a channel name', 'ai:th1'],
  ])('refuses options with %s in place of the thread’s channel', (_name, channel) => {
    // CAST: options as JavaScript code could pass them.
    const options = { url: '/api/agent', channel } as unknown as AblyAgentOptions;

    expect(() => createAblyAgent(options)).toThrowErrorInfo({ code: ErrorCode.InvalidArgument, statusCode: 400 });
  });

  describe('runAgent()', () => {
    it('posts the run’s input as HttpAgent does, once the thread’s channel is attached', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend, { headers: { authorization: 'Bearer t' }, initialMessages: [prompt] });

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();

      const [url, init] = backend.mock.calls[0] ?? [];
      expect(url).toBe('/api/agent');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer t',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      });
      expect(postedInput(backend)).toMatchObject({ threadId: THREAD, runId: 'r1', messages: [prompt] });

      fixture.deliver(wireOf(reply).live);
      await running;
    });

    it('posts nothing until the channel’s attach has resolved, so the run’s first event can’t be missed', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);
      const attaching = holdAttach(fixture);

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      expect(fixture.channel.listener).toBeDefined();
      expect(backend).not.toHaveBeenCalled();

      attaching.open();
      await nextMacrotask();
      expect(backend).toHaveBeenCalledTimes(1);
      fixture.deliver(wireOf(reply).live);
      await running;
    });

    it('reads the run off the channel, and AG-UI’s own reducer builds the reply', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend(), { initialMessages: [prompt] });

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live);
      const { newMessages } = await running;

      expect(agent.messages).toEqual([prompt, replyMessage]);
      expect(newMessages).toEqual([replyMessage]);
    });

    it('shows the prompt RUN_STARTED carries in its input once, since the tab that sent it holds it by its id', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const inputs: AGUI.RunAgentInput[] = [];
      agent.subscribe({
        onRunStartedEvent: ({ event }) => {
          if (event.input !== undefined) inputs.push(event.input);
        },
      });
      agent.addMessage(prompt);

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(withPrompt(reply, prompt)).live);
      await running;

      expect(inputs).toMatchObject([{ messages: [prompt] }]);
      expect(agent.messages).toEqual([prompt, replyMessage]);
    });

    it('passes over another run’s events until the RUN_STARTED that carries its runId', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      // A stopped run still ending, then this tab's run.
      const { live } = wireOf([...textRun('r0', 'm0', ['Old']), ...reply]);

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(live);
      await running;

      expect(replies(agent.messages)).toEqual(['Hi there']);
    });

    it('passes over a message it cannot decode before its RUN_STARTED, as another run’s', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const [started, opened, ...rest] = wireOf([...textRun('r0', 'm0', ['Old']), ...reply]).live;
      const broken = opened === undefined ? [] : [{ ...opened, data: 'not an event' }];

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver([...(started === undefined ? [] : [started]), ...broken, ...rest]);
      await running;

      expect(replies(agent.messages)).toEqual(['Hi there']);
    });

    it('checks the input against the agent’s own limit on entries, as HttpAgent does', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      // The agent's own limit, as AG-UI 1.0.4 and later hold it.
      Object.assign(agent, { maxEnforcedEntries: 2_000_000 });

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live);
      await running;

      expect(AGUI.enforceOutgoingInput).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'r1' }), {
        maxEntries: 2_000_000,
      });
    });

    it('posts the threadId AG-UI puts on the input, and reads the channel it was created with', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);

      agent.threadId = 'th2';
      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live);
      await running;

      expect(postedInput(backend)).toMatchObject({ threadId: 'th2' });
      expect(replies(agent.messages)).toEqual(['Hi there']);
    });

    it('ends at its RUN_ERROR, which AG-UI reports as the run’s error event', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const errors = runErrors();
      const failed: AGUI.Event[] = [
        ...reply.slice(0, 3),
        { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
        { type: EventType.RUN_ERROR, message: 'the model failed', code: 'model_error' },
      ];

      const running = agent.runAgent({ runId: 'r1' }, errors.subscriber);
      await nextMacrotask();
      fixture.deliver(wireOf(failed).live);
      await running;

      expect(errors.events).toMatchObject([{ code: 'model_error' }]);
      expect(replies(agent.messages)).toEqual(['Hi ']);
    });

    it('ends with no end event when another run starts before this one ends, as when its backend died', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const errors = runErrors();
      const { live } = wireOf([...reply.slice(0, 3), ...textRun('r2', 'm2', ['Next'])]);

      const running = agent.runAgent({ runId: 'r1' }, errors.subscriber);
      await nextMacrotask();
      fixture.deliver(live);
      await running;

      expect(errors.events).toEqual([]);
      expect(replies(agent.messages)).toEqual(['Hi ']);
      expect(fixture.channel.listener).toBeUndefined();
    });

    it('fails with SessionSendFailed, carrying the status, when the backend answers outside 2xx', async () => {
      const fixture = channelWith();
      // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once
      const backend: Backend = vi.fn(async () => new Response('thread is busy', { status: 409 }));
      const agent = agentOn(fixture, backend);

      await expect(agent.runAgent({ runId: 'r1' })).rejects.toBeErrorInfo({
        message: 'unable to run the agent; /api/agent answered 409: thread is busy',
        code: ErrorCode.SessionSendFailed,
        statusCode: 409,
      });
      expect(fixture.channel.listener).toBeUndefined();
    });

    it('fails with SessionSendFailed when the request gets no response', async () => {
      const fixture = channelWith();
      const backend: Backend = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const agent = agentOn(fixture, backend);

      await expect(agent.runAgent({ runId: 'r1' })).rejects.toBeErrorInfo({
        message: 'unable to run the agent; fetch failed',
        code: ErrorCode.SessionSendFailed,
        statusCode: 500,
      });
    });

    it('only logs an answer outside 2xx that comes after the run ended in this tab', async () => {
      const fixture = channelWith();
      const answering = gate();
      const backend: Backend = vi.fn(async () => {
        await answering.promise;
        return new Response('too late', { status: 500 });
      });
      const { logger, messages: warnings } = recordingLogger(LogLevel.Warn);
      const agent = agentOn(fixture, backend, { logger });

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live);
      await running;
      answering.open();
      await nextMacrotask();

      expect(replies(agent.messages)).toEqual(['Hi there']);
      expect(warnings).toEqual([expect.stringContaining('the request failed after the run ended in this tab')]);
    });

    it('reads the response to its end, and holds it open after the run ends in this tab', async () => {
      const fixture = channelWith();
      let cancelled = false;
      let respond: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          respond = controller;
        },
        cancel: () => {
          cancelled = true;
        },
      });
      // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once
      const backend: Backend = vi.fn(async () => new Response(body, { status: 200 }));
      const agent = agentOn(fixture, backend);

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live);
      await running;
      await nextMacrotask();

      expect(body.locked).toBe(true);
      expect(cancelled).toBe(false);
      respond?.close();
    });

    it('reads on from the channel when the response breaks after the backend accepted the run', async () => {
      const fixture = channelWith();
      let respond: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          respond = controller;
        },
      });
      // eslint-disable-next-line @typescript-eslint/require-await -- the backend answers at once
      const backend: Backend = vi.fn(async () => new Response(body, { status: 200 }));
      const agent = agentOn(fixture, backend);
      const { live } = wireOf(reply);

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(live.slice(0, 3));
      respond?.error(new TypeError('network error'));
      await nextMacrotask();
      fixture.deliver(live.slice(3));

      await running;
      expect(replies(agent.messages)).toEqual(['Hi there']);
    });

    it('still posts a run AG-UI stops reading before the channel attached, as HttpAgent’s request is out by then', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);
      const subscribing = holdSubscribe(fixture);

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      await agent.detachActiveRun();
      await running;

      expect(backend).toHaveBeenCalledTimes(1);
      expect(postedInput(backend)).toMatchObject({ runId: 'r1' });
      subscribing.open();
      await nextMacrotask();
      expect(fixture.channel.attach).not.toHaveBeenCalled();
    });

    it('fails with the channel’s own code, posting nothing, when the channel refuses the attach', async () => {
      const fixture = channelWith();
      fixture.channel.attach.mockRejectedValueOnce(new Ably.ErrorInfo('channel denied access', 40160, 401));
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);

      await expect(agent.runAgent({ runId: 'r1' })).rejects.toBeErrorInfo({ code: 40160, statusCode: 401 });
      expect(backend).not.toHaveBeenCalled();
    });

    it('fails with SessionContinuityNotGuaranteed when the channel loses continuity during the run', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live.slice(0, 3));
      fixture.channel.emitStateChange({ current: 'suspended', previous: 'attached', resumed: false });

      await expect(running).rejects.toBeErrorInfo({ code: ErrorCode.SessionContinuityNotGuaranteed });
    });

    it('ends with no error and no end event when the channel becomes DETACHED, as when the page closes its client', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const errors = runErrors();

      const running = agent.runAgent({ runId: 'r1' }, errors.subscriber);
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live.slice(0, 3));
      fixture.channel.emitStateChange({ current: 'detached', previous: 'attached', resumed: false });

      await running;
      expect(errors.events).toEqual([]);
      expect(replies(agent.messages)).toEqual(['Hi ']);
    });

    it('fails with SessionMessageProcessingFailed when a message of the run cannot be decoded', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const [started, opened] = wireOf(reply).live;

      const running = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(started === undefined ? [] : [started]);
      fixture.deliver(opened === undefined ? [] : [{ ...opened, data: 'not an event' }]);

      await expect(running).rejects.toBeErrorInfo({ code: ErrorCode.SessionMessageProcessingFailed });
    });

    it('fails with InvalidArgument, posting nothing, when AG-UI refuses the input', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      // CAST: a message whose id is not a string, as an untyped store could hand back.
      const malformed = { id: 42, role: 'user', content: 'Hello?' } as unknown as AGUI.Message;
      const agent = agentOn(fixture, backend, { initialMessages: [malformed] });

      await expect(agent.runAgent({ runId: 'r1' })).rejects.toBeErrorInfo({ code: ErrorCode.InvalidArgument });
      expect(backend).not.toHaveBeenCalled();
      expect(fixture.channel.subscribe).not.toHaveBeenCalled();
    });

    it('leaves the channel attached after each run, for the application to detach', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());

      const runs: [string, AGUI.Event[]][] = [
        ['r1', reply],
        ['r2', textRun('r2', 'm2', ['Bye'])],
      ];
      for (const [runId, run] of runs) {
        const running = agent.runAgent({ runId });
        await nextMacrotask();
        fixture.deliver(wireOf(run).live);
        await running;
        await nextMacrotask();
      }

      expect(fixture.channel.detach).not.toHaveBeenCalled();
      expect(fixture.channel.state).toBe('attached');
      expect(fixture.channel.listener).toBeUndefined();
      expect(replies(agent.messages)).toEqual(['Hi there', 'Bye']);
    });
  });

  describe('abortRun()', () => {
    it('aborts the run’s request, as HttpAgent’s does, and ends the run in this tab with RUN_ERROR and the code abort', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);
      const errors = runErrors();

      const running = agent.runAgent({ runId: 'r1' }, errors.subscriber);
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live.slice(0, 3));
      agent.abortRun();
      await running;

      expect(backend.mock.calls[0]?.[1].signal?.aborted).toBe(true);
      expect(errors.events).toMatchObject([{ type: EventType.RUN_ERROR, code: 'abort' }]);
      expect(replies(agent.messages)).toEqual(['Hi ']);
      expect(fixture.channel.listener).toBeUndefined();
    });

    it('hands that RUN_ERROR to the agent’s subscribers, so one can send the cancel for the run, even one stopped before its RUN_STARTED', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      const cancels: { threadId: string; runId: string }[] = [];
      const onRunFailed = vi.fn();
      let runId: string | undefined;
      agent.subscribe({
        onRunInitialized: ({ input }) => {
          runId = input.runId;
        },
        onRunStartedEvent: ({ event }) => {
          runId = event.runId;
        },
        onRunErrorEvent: ({ event }) => {
          if (event.code !== 'abort' || runId === undefined) return;
          cancels.push({ threadId: agent.threadId, runId });
        },
        onRunFailed,
      });

      const first = agent.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live.slice(0, 3));
      agent.abortRun();
      await expect(first).resolves.toMatchObject({ newMessages: [{ id: 'm1', content: 'Hi ' }] });
      await nextMacrotask();
      const second = agent.runAgent({ runId: 'r2' });
      await nextMacrotask();
      agent.abortRun();
      await second;

      expect(cancels).toEqual([
        { threadId: THREAD, runId: 'r1' },
        { threadId: THREAD, runId: 'r2' },
      ]);
      expect(onRunFailed).not.toHaveBeenCalled();
    });

    it('ends the run the same way when the caller aborts the abortController it gave runAgent()', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);
      const errors = runErrors();
      const controller = new AbortController();

      const running = agent.runAgent({ runId: 'r1', abortController: controller }, errors.subscriber);
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live.slice(0, 3));
      controller.abort();
      await running;

      expect(backend.mock.calls[0]?.[1].signal?.aborted).toBe(true);
      expect(errors.events).toMatchObject([{ code: 'abort' }]);
      expect(replies(agent.messages)).toEqual(['Hi ']);
    });

    it('ends a run at once, posting nothing, when the abortController it is given was aborted before it started', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);
      const errors = runErrors();
      const controller = new AbortController();
      controller.abort();

      await agent.runAgent({ runId: 'r1', abortController: controller }, errors.subscriber);
      await nextMacrotask();

      expect(errors.events).toMatchObject([{ code: 'abort' }]);
      expect(backend).not.toHaveBeenCalled();
      expect(fixture.channel.subscribe).not.toHaveBeenCalled();
    });

    it.each([
      ['subscribes to', holdSubscribe],
      ['attaches', holdAttach],
    ])('posts nothing for a run it stops while the read %s the channel', async (_step, hold) => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);
      const errors = runErrors();
      const held = hold(fixture);

      const running = agent.runAgent({ runId: 'r1' }, errors.subscriber);
      await nextMacrotask();
      agent.abortRun();
      await running;
      held.open();
      await nextMacrotask();

      expect(backend).not.toHaveBeenCalled();
      expect(errors.events).toMatchObject([{ code: 'abort' }]);
    });
  });

  describe('connectAgent()', () => {
    it('reads nothing, and leaves the agent’s messages and state as they are, as HttpAgent’s does', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend(), { initialMessages: [prompt], initialState: { step: 1 } });

      const { newMessages } = await agent.connectAgent();

      expect(newMessages).toEqual([]);
      expect(agent.messages).toEqual([prompt]);
      expect(agent.state).toEqual({ step: 1 });
      expect(fixture.channel.subscribe).not.toHaveBeenCalled();
    });

    it('applies the events the agent’s connect() returns, as the developer’s own join of a run in progress does', async () => {
      const fixture = channelWith();
      const agent = agentOn(fixture, acceptingBackend());
      // The developer's join reads the run from the channel; here it hands
      // over the run another tab started, prompt and all.
      Object.assign(agent, { connect: () => Rx.from(withPrompt(reply, prompt)) });

      const { newMessages } = await agent.connectAgent();

      expect(newMessages).toEqual([prompt, replyMessage]);
      expect(agent.messages).toEqual([prompt, replyMessage]);
    });
  });

  describe('clone()', () => {
    it('keeps the channel and HttpAgent’s options', async () => {
      const fixture = channelWith();
      const backend = acceptingBackend();
      const agent = agentOn(fixture, backend);

      const copy = agent.clone();
      const running = copy.runAgent({ runId: 'r1' });
      await nextMacrotask();
      fixture.deliver(wireOf(reply).live);
      await running;

      expect(backend).toHaveBeenCalledWith('/api/agent', expect.anything());
      expect(replies(copy.messages)).toEqual(['Hi there']);
      expect(agent.messages).toEqual([]);
    });
  });
});
