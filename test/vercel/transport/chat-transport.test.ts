/**
 * ChatTransport unit tests — the useChat adapter over the standalone
 * ClientTransport.
 *
 * On the streaming path the adapter decides which stream a chunk belongs on
 * and forwards it unchanged, reading transport metadata only; on the hydration
 * path it merges walked history into messages and retains an unfinished run's
 * events. These tests drive it against a fake ClientTransport, covering
 * the three send paths, the run id arriving over the channel, the hydration
 * walk and the reconnect that pairs with it, step supersede, and the terminal
 * rules for a stream the adapter has handed out.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput } from '../../../src/vercel/codec/events.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import {
  assistantChunks,
  type Event,
  FakeClientTransport,
  messageEvent,
  readAll,
  runEndEvent,
  runErrorEvent,
  runStartEvent,
  runSuspendEvent,
  stepStartEvent,
  stubChatFetch,
  stubChatFetchFailure,
} from './helpers.js';

const userMessage = (id: string, text: string): AI.UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/**
 * An adapter over a fresh fake transport.
 * @param autoRunId - Resolve every publish's run-id promise with this id, as a channel that already carries `ai-run-start` would.
 * @returns The fake transport and the adapter.
 */
const setup = (autoRunId?: string): { fake: FakeClientTransport; chat: ChatTransport } => {
  const fake = new FakeClientTransport();
  fake.autoRunId = autoRunId;
  const chat = createChatTransport({ transport: fake, channelName: 'ai:test' });
  return { fake, chat };
};

const sendOptions = (
  messages: AI.UIMessage[],
  overrides: {
    trigger?: 'submit-message' | 'regenerate-message';
    messageId?: string;
    abortSignal?: AbortSignal;
  } = {},
): Parameters<ChatTransport['sendMessages']>[0] => ({
  trigger: overrides.trigger ?? 'submit-message',
  chatId: 'ai:test',
  messageId: overrides.messageId,
  messages,
  abortSignal: overrides.abortSignal,
});

/**
 * An assistant message whose tool call the user has approved.
 * @param id - The message's domain id.
 * @returns The message.
 */
const approvedAssistant = (id = 'a1'): AI.UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    {
      type: 'tool-getWeather',
      toolCallId: 'tc-1',
      state: 'approval-responded',
      input: { city: 'Berlin' },
      approval: { id: 'ap-1', approved: true },
    },
  ],
});

/**
 * An assistant message whose client-side tool has produced its output.
 * @param id - The message's domain id.
 * @returns The message.
 */
const executedAssistant = (id = 'a1'): AI.UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    {
      type: 'tool-getWeather',
      toolCallId: 'tc-1',
      state: 'output-available',
      input: { city: 'Berlin' },
      output: { tempC: 4 },
    },
  ],
});

/**
 * An output-carrying wire event under a run — one delivery of one wire
 * message. A streamed message keeps its channel serial for its whole life and
 * advances `version.serial` per append, so a fixture that models an append
 * repeats the serial and passes a fresh `versionSerial` (see
 * {@link appendEvent}). A single delivery gets both from `serial`.
 * @param runId - The run the output belongs to.
 * @param transportMessageId - The wire message the chunks accumulate on.
 * @param chunks - The decoded output chunks.
 * @param serial - The wire message's channel serial.
 * @param versionSerial - The delivery's version serial. Defaults to `serial`, as a first delivery's does.
 * @returns The event.
 */
const outputEvent = (
  runId: string,
  transportMessageId: string,
  chunks: AI.UIMessageChunk[],
  serial = 'serial-1',
  versionSerial = serial,
): Event => messageEvent({ runId, transportMessageId, role: 'assistant', serial, versionSerial }, { outputs: chunks });

/**
 * A later append of a wire message already on the channel: the same channel
 * serial, a new version serial. This is what a streaming reply actually looks
 * like on the wire, and keying anything on `serial` alone collapses it.
 * @param runId - The run the output belongs to.
 * @param transportMessageId - The wire message the chunks accumulate on.
 * @param chunks - The decoded output chunks this append carried.
 * @param serial - The wire message's channel serial, unchanged from the first delivery.
 * @param versionSerial - This append's version serial.
 * @returns The event.
 */
const appendEvent = (
  runId: string,
  transportMessageId: string,
  chunks: AI.UIMessageChunk[],
  serial: string,
  versionSerial: string,
): Event => outputEvent(runId, transportMessageId, chunks, serial, versionSerial);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatTransport', () => {
  // -- fresh send ----------------------------------------------------------

  describe('fresh send', () => {
    it('publishes the message body, POSTs the pointer, and streams the run', async () => {
      const fetchMock = stubChatFetch();
      const { fake, chat } = setup('run-1');

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hello')]));

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({ kind: 'message', payload: userMessage('u1', 'hello') });
      // The adapter mints the id rather than leaving it to the transport, so
      // it can recognise its own echo (see onForeignInput).
      expect(fake.published[0]?.opts?.transportMessageId).toBeTypeOf('string');
      expect(fetchMock).toHaveBeenCalledOnce();
      const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      expect(body).toEqual({ channelName: 'ai:test', eventId: 'ev-1' });

      // The POST body says nothing about the run; the channel does.
      await Promise.resolve();
      fake.emit(outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'hi')));
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual(assistantChunks('a1', 'hi'));
    });

    it('takes the run id off the channel, not the POST response', async () => {
      // A route answering with a run id the channel never confirms must not
      // steer the stream: the body is not read at all.
      stubChatFetch();
      const { fake, chat } = setup();

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hello')]));
      fake.resolveRunId('run-from-channel');
      await Promise.resolve();

      fake.emit(outputEvent('run-from-channel', 'wire-a1', assistantChunks('a1', 'hi')));
      fake.emit(runEndEvent('run-from-channel'));

      expect(await readAll(stream)).toEqual(assistantChunks('a1', 'hi'));
    });

    it('buffers events that arrive before the run id resolves', async () => {
      stubChatFetch();
      const { fake, chat } = setup();

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hello')]));
      // Output beats the run-id resolution onto the wire.
      fake.emit(outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'hi')));
      fake.resolveRunId('run-1');
      await Promise.resolve();
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual(assistantChunks('a1', 'hi'));
    });

    it('ignores another run’s output on the same channel', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hello')]));
      await Promise.resolve();
      fake.emit(outputEvent('run-other', 'wire-x', assistantChunks('x1', 'not mine')));
      fake.emit(outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'mine')));
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual(assistantChunks('a1', 'mine'));
    });

    it('rejects with SessionSendFailed when the route answers non-2xx', async () => {
      stubChatFetch(500);
      const { chat } = setup('run-1');

      await expect(chat.sendMessages(sendOptions([userMessage('u1', 'hello')]))).rejects.toBeErrorInfoWithCode(
        ErrorCode.SessionSendFailed,
      );
      expect(chat.streaming).toBe(false);
    });

    it('rejects with SessionSendFailed when the route is unreachable', async () => {
      stubChatFetchFailure(new TypeError('network down'));
      const { chat } = setup('run-1');

      // The plain Error is wrapped so the chain carries it, rather than being
      // dropped by `errorCause` and surviving only in the message.
      await expect(chat.sendMessages(sendOptions([userMessage('u1', 'hello')]))).rejects.toBeErrorInfo({
        code: ErrorCode.SessionSendFailed,
        message: 'unable to send; the POST to /api/chat failed; network down',
        cause: { message: 'network down' },
      });
    });

    it('errors the stream when the run never starts', async () => {
      stubChatFetch();
      const { fake, chat } = setup();

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hello')]));
      fake.rejectRunId(new Ably.ErrorInfo('run never started', ErrorCode.SessionClosed, 500));

      await expect(readAll(stream)).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
      expect(chat.streaming).toBe(false);
    });

    it('rejects an empty message list', async () => {
      stubChatFetch();
      const { chat } = setup('run-1');

      await expect(chat.sendMessages(sendOptions([]))).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('rejects once closed', async () => {
      stubChatFetch();
      const { chat } = setup('run-1');
      chat.close();

      await expect(chat.sendMessages(sendOptions([userMessage('u1', 'hi')]))).rejects.toBeErrorInfoWithCode(
        ErrorCode.SessionClosed,
      );
    });

    it('refuses to walk once closed', async () => {
      const { chat } = setup();
      chat.close();

      await expect(chat.readSince()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });

    it('resumes nothing once closed', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [{ events: [runStartEvent('run-1', 'serial-10')], exhausted: true }];
      await chat.readSince();
      chat.close();

      // eslint-disable-next-line unicorn/no-null -- the SDK contract is null
      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBe(null);
    });

    it('stops reporting streaming transitions after unsubscribe', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const seen: boolean[] = [];
      const off = chat.onStreamingChange((v) => seen.push(v));
      off();

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();
      fake.emit(runEndEvent('run-1'));
      await readAll(stream);

      expect(seen).toEqual([]);
    });
  });

  // -- stream termination --------------------------------------------------

  describe('stream termination', () => {
    it('closes on the run’s end', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emit(runEndEvent('run-1'));
      expect(await readAll(stream)).toEqual([]);
      expect(chat.streaming).toBe(false);
    });

    it('errors when the run ends in error', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emit(runErrorEvent('run-1', new Ably.ErrorInfo('the route died', ErrorCode.RunResponseStreamFailed, 500)));

      await expect(readAll(stream)).rejects.toBeErrorInfoWithCode(ErrorCode.RunResponseStreamFailed);
    });

    it('errors every open stream when channel continuity is lost', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emitError(new Ably.ErrorInfo('continuity lost', ErrorCode.SessionContinuityNotGuaranteed, 500));

      await expect(readAll(stream)).rejects.toBeErrorInfoWithCode(ErrorCode.SessionContinuityNotGuaranteed);
      expect(chat.streaming).toBe(false);
    });

    it('leaves streams alone for a non-fatal transport error', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emitError(new Ably.ErrorInfo('one bad message', ErrorCode.SessionMessageProcessingFailed, 500));
      fake.emit(outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'still here')));
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual(assistantChunks('a1', 'still here'));
    });

    it('errors the stream when a forwarded step attempt starts again', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emit(messageEvent({ runId: 'run-1', transportMessageId: 'wire-a1', stepId: 's1' }, { outputs: [] }));
      fake.emit(stepStartEvent('run-1', 's1', 'serial-200'));

      await expect(readAll(stream)).rejects.toBeErrorInfoWithCode(ErrorCode.Conflict);
      expect(chat.streaming).toBe(false);
    });

    it('lets a first step attempt open without erroring', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emit(stepStartEvent('run-1', 's1'));
      fake.emit(outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'fine')));
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream)).toEqual(assistantChunks('a1', 'fine'));
    });

    it('does not close on a suspend — the design never suspends a run', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      // Reaching this means the agent suspended instead of ending, which the
      // adapter cannot invent a terminal for. The stream stays open and only a
      // log records it; the run's own end is still the only close.
      fake.emit(runSuspendEvent('run-1'));
      expect(chat.streaming).toBe(true);

      fake.emit(runEndEvent('run-1'));
      expect(await readAll(stream)).toEqual([]);
      expect(chat.streaming).toBe(false);
    });

    it('closes open streams on close(), so a held reader terminates', async () => {
      stubChatFetch();
      const { chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      chat.close();

      expect(await readAll(stream)).toEqual([]);
      expect(chat.streaming).toBe(false);
    });

    it('drops the collector when useChat cancels its reader', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();
      expect(chat.streaming).toBe(true);

      await stream.cancel();

      expect(chat.streaming).toBe(false);
      // A later event for that run reaches nothing.
      fake.emit(outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'ignored')));
    });
  });

  // -- streaming state -----------------------------------------------------

  describe('streaming state', () => {
    it('reports the transitions around one run', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const seen: boolean[] = [];
      chat.onStreamingChange((value) => seen.push(value));

      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();
      expect(chat.streaming).toBe(true);

      fake.emit(runEndEvent('run-1'));
      await readAll(stream);

      expect(seen).toEqual([true, false]);
    });
  });

  // -- cancelling ----------------------------------------------------------

  describe('cancelling', () => {
    it('cancels over the channel when the send is aborted', async () => {
      stubChatFetch();
      const controller = new AbortController();
      const { fake, chat } = setup('run-1');

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')], { abortSignal: controller.signal }));
      await Promise.resolve();
      controller.abort();

      // The cancel publish is fire-and-forget from the abort listener.
      await vi.waitFor(() => {
        expect(fake.cancelled).toEqual(['run-1']);
      });
    });

    it('cancels once the run id lands, when the abort beat it', async () => {
      stubChatFetch();
      const controller = new AbortController();
      const { fake, chat } = setup();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')], { abortSignal: controller.signal }));
      controller.abort();
      expect(fake.cancelled).toEqual([]);

      fake.resolveRunId('run-1');
      await vi.waitFor(() => {
        expect(fake.cancelled).toEqual(['run-1']);
      });
    });

    it('cancel() reaches the agent for the open run', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      await chat.cancel();

      expect(fake.cancelled).toEqual(['run-1']);
    });

    it('cancel() reaches the agent when Stop beats the run id', async () => {
      stubChatFetch();
      const { fake, chat } = setup();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      // No `ai-run-start` yet, so there is no id to address — the cancel has
      // to ride the pending promise or the agent keeps generating against a
      // UI that has already stopped.
      const cancelled = chat.cancel();
      expect(fake.cancelled).toEqual([]);

      fake.resolveRunId('run-1');
      await cancelled;

      expect(fake.cancelled).toEqual(['run-1']);
    });

    it('cancel() is a no-op when idle', async () => {
      const { fake, chat } = setup();
      await chat.cancel();
      expect(fake.cancelled).toEqual([]);
    });
  });

  // -- continuation --------------------------------------------------------

  describe('continuation', () => {
    it('publishes an approval decision addressed by the message id', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-2');
      const assistant = approvedAssistant();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: assistant.id }));

      // The body names the assistant; the wire id is minted like any other
      // publish and never carries a domain id.
      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({
        kind: 'approval',
        payload: { messageId: 'a1', toolCallId: 'tc-1', approved: true },
      });
      expect(fake.published[0]?.opts?.transportMessageId).toBeTypeOf('string');
      expect(fake.published[0]?.opts?.transportMessageId).not.toBe('a1');
    });

    it('publishes the provider tool-output chunk for a client-executed tool', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-2');
      const assistant = executedAssistant();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: assistant.id }));

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({
        kind: 'chunk',
        payload: {
          messageId: 'a1',
          chunk: { type: 'tool-output-available', toolCallId: 'tc-1', output: { tempC: 4 } },
        },
      });
      expect(fake.published[0]?.opts?.transportMessageId).not.toBe('a1');
    });

    it('publishes the tool-output-error chunk for a failed client tool', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-2');
      const assistant: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-getWeather',
            toolCallId: 'tc-1',
            state: 'output-error',
            input: { city: 'Berlin' },
            errorText: 'boom',
          },
        ],
      };

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: assistant.id }));

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({
        kind: 'chunk',
        payload: { messageId: 'a1', chunk: { type: 'tool-output-error', toolCallId: 'tc-1', errorText: 'boom' } },
      });
    });

    it('carries no run id — a resolution opens a new run like any other input', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-2');
      const assistant = approvedAssistant();

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: assistant.id }));

      expect(fake.published[0]?.opts).not.toHaveProperty('runId');
    });

    it('publishes every resolved part in order and POSTs the last one', async () => {
      const fetchMock = stubChatFetch();
      const { fake, chat } = setup('run-2');
      const assistant: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-getWeather',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: { city: 'Berlin' },
            output: { tempC: 4 },
          },
          {
            type: 'tool-getTime',
            toolCallId: 'tc-2',
            state: 'approval-responded',
            input: {},
            approval: { id: 'ap-1', approved: true },
          },
        ],
      };

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: assistant.id }));

      expect(fake.published.map((p) => p.event.kind)).toEqual(['chunk', 'approval']);
      // Both actions share one wire id, because they are one continuation, and
      // both name the assistant in their own body.
      const wireIds = new Set(fake.published.map((p) => p.opts?.transportMessageId));
      expect(wireIds.size).toBe(1);
      expect(wireIds.has('a1')).toBe(false);
      // The POST points at the last publish: the earlier actions are already
      // on the channel ahead of it when the agent locates this one.
      const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect((JSON.parse(init?.body ?? '{}') as { eventId: string }).eventId).toBe('ev-2');
    });

    it('rejects when the named message has no resolved tool parts', async () => {
      stubChatFetch();
      const { chat } = setup('run-2');
      const assistant: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'nothing to resolve' }],
      };

      await expect(
        chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: assistant.id })),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('treats a submit naming a user message as a fresh send', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const user = userMessage('u1', 'hello');

      await chat.sendMessages(sendOptions([user], { messageId: user.id }));

      expect(fake.published[0]?.event).toEqual({ kind: 'message', payload: user });
    });
  });

  // -- regeneration --------------------------------------------------------

  describe('regeneration', () => {
    it('publishes the message it regenerates from', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-3');

      await chat.sendMessages(
        sendOptions([userMessage('u1', 'hi')], { trigger: 'regenerate-message', messageId: 'a1' }),
      );

      expect(fake.published).toHaveLength(1);
      expect(fake.published[0]?.event).toEqual({ kind: 'regenerate', payload: { messageId: 'a1' } });
      expect(fake.published[0]?.opts?.transportMessageId).toBeTypeOf('string');
    });

    it('rejects when useChat names no message', async () => {
      stubChatFetch();
      const { chat } = setup('run-3');

      await expect(
        chat.sendMessages(sendOptions([userMessage('u1', 'hi')], { trigger: 'regenerate-message' })),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- hydration walk ------------------------------------------------------

  describe('readSince', () => {
    it('returns the walked messages, oldest first', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            messageEvent(
              { transportMessageId: 'wire-u1', role: 'user', serial: 'serial-10' },
              { inputs: [{ kind: 'message', payload: userMessage('u1', 'forecast?') }] },
            ),
            runStartEvent('run-1', 'serial-11'),
            outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'It is 4C'), 'serial-12'),
            runEndEvent('run-1'),
          ],
          exhausted: true,
        },
      ];

      const { messages, exhausted } = await chat.readSince();

      expect(exhausted).toBe(true);
      expect(messages.map((message) => message.id)).toEqual(['u1', 'a1']);
      // The events come back as published; assembling them is the caller's job.
      expect(messages[1]?.events).toContainEqual({
        direction: 'output',
        event: { type: 'text-delta', id: 'a1-t', delta: 'It is 4C' },
      });
    });

    it('withholds a message whose run has not ended', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'done'), 'serial-11'),
            runEndEvent('run-1'),
            runStartEvent('run-2', 'serial-20'),
            outputEvent('run-2', 'wire-a2', [{ type: 'start', messageId: 'a2' }], 'serial-21'),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((message) => message.id)).toEqual(['a1']);
    });

    it('stops at the store’s serial and excludes what the store already holds', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            outputEvent('run-0', 'wire-a0', assistantChunks('a0', 'old'), 'serial-05'),
            runEndEvent('run-0'),
            outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'new'), 'serial-20'),
            runEndEvent('run-1'),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince('serial-10');

      expect(messages.map((message) => message.id)).toEqual(['a1']);
    });

    it('reports exhausted false when the walk stopped at the serial', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'new'), 'serial-20'), runEndEvent('run-1')],
          exhausted: false,
        },
        {
          events: [outputEvent('run-0', 'wire-a0', assistantChunks('a0', 'old'), 'serial-05'), runEndEvent('run-0')],
          exhausted: false,
        },
      ];

      const { exhausted } = await chat.readSince('serial-10');

      expect(exhausted).toBe(false);
    });

    it('keeps every part of a message the codec exploded across wire events', async () => {
      const { fake, chat } = setup();
      // The `message` batch publishes one wire event per part, and each decodes
      // back as a one-part input.
      fake.historyBatches = [
        {
          events: [
            messageEvent(
              { transportMessageId: 'wire-u1', role: 'user', serial: 'serial-10' },
              {
                inputs: [
                  { kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look at ' }] } },
                ],
              },
            ),
            messageEvent(
              { transportMessageId: 'wire-u1', role: 'user', serial: 'serial-11' },
              {
                inputs: [
                  { kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'this' }] } },
                ],
              },
            ),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      // The wire fans one message out per part, so the group holds one input
      // per part and the caller concatenates them.
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe('u1');
      expect(messages[0]?.events.map((walked) => walked.event)).toEqual([
        { kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look at ' }] } },
        { kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'this' }] } },
      ]);
    });

    it('drops a superseded step attempt from the walk', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            messageEvent(
              {
                runId: 'run-1',
                transportMessageId: 'wire-dead',
                role: 'assistant',
                serial: 'serial-11',
                stepId: 's1',
                stepStartSerial: 'serial-100',
              },
              { outputs: assistantChunks('dead', 'half a repl') },
            ),
            messageEvent(
              {
                runId: 'run-1',
                transportMessageId: 'wire-a1',
                role: 'assistant',
                serial: 'serial-12',
                stepId: 's1',
                stepStartSerial: 'serial-103',
              },
              { outputs: assistantChunks('a1', 'the whole reply') },
            ),
            runEndEvent('run-1'),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((message) => message.id)).toEqual(['a1']);
    });
  });

  // -- a second walk ---------------------------------------------------------

  describe('walked tool resolutions', () => {
    it('folds a client-published tool output into the assistant it amends', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            outputEvent(
              'run-1',
              'wire-a1',
              [
                { type: 'start', messageId: 'a1' },
                { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getWeather', input: { city: 'Berlin' } },
                { type: 'finish' },
              ],
              'serial-11',
            ),
            runEndEvent('run-1'),
            // The client ran the tool and published its output against the
            // assistant, which is how a client-side tool resolves.
            messageEvent(
              { runId: 'run-1', transportMessageId: 'wire-a1', serial: 'serial-12', versionSerial: 'serial-12' },
              {
                inputs: [
                  {
                    kind: 'chunk',
                    payload: {
                      messageId: 'a1',
                      chunk: { type: 'tool-output-available', toolCallId: 'tc-1', output: { tempC: 4 } },
                    },
                  },
                ],
              },
            ),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      // The resolution names the assistant it amends, so it groups with that
      // assistant's own chunks. Putting it anywhere else would rebuild the
      // assistant with its tool call stuck in `input-available`, so the UI
      // shows a spinner for a tool that already answered.
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe('a1');
      expect(messages[0]?.events.at(-1)).toEqual({
        direction: 'input',
        event: {
          kind: 'chunk',
          payload: {
            messageId: 'a1',
            chunk: { type: 'tool-output-available', toolCallId: 'tc-1', output: { tempC: 4 } },
          },
        },
      });
    });
  });

  describe('grouping the walk', () => {
    it('joins two publishes of one assistant message on the id their start chunks carry', async () => {
      // The approval flow: the agent opens the message in one run, pauses at
      // the request, and a second run continues the SAME message after the
      // decision. Keying on the wire id alone splits it in two.
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            outputEvent(
              'run-1',
              'wire-a',
              [
                { type: 'start', messageId: 'ui-1' },
                { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getForecast', input: {} },
                { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'tc-1' },
                { type: 'finish' },
              ],
              'serial-11',
            ),
            runEndEvent('run-1'),
            runStartEvent('run-2', 'serial-12'),
            outputEvent(
              'run-2',
              'wire-b',
              [
                { type: 'start', messageId: 'ui-1' },
                { type: 'tool-output-available', toolCallId: 'tc-1', output: { days: 5 } },
                { type: 'finish' },
              ],
              'serial-13',
            ),
            runEndEvent('run-2'),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((message) => message.id)).toEqual(['ui-1']);
      // Both publishes' chunks, in wire order, so one reducer call rebuilds
      // the resolved tool call.
      expect(
        messages[0]?.events.flatMap((walked) => (walked.direction === 'output' ? [walked.event.type] : [])),
      ).toEqual([
        'start',
        'tool-input-available',
        'tool-approval-request',
        'finish',
        'start',
        'tool-output-available',
        'finish',
      ]);
    });

    it('groups an approval decision with the assistant its body names', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            outputEvent(
              'run-1',
              'wire-a',
              [
                { type: 'start', messageId: 'ui-1' },
                { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getForecast', input: {} },
                { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'tc-1' },
                { type: 'finish' },
              ],
              'serial-11',
            ),
            runEndEvent('run-1'),
            // The client's decision rides its own wire message, and names the
            // assistant it answers.
            messageEvent(
              { transportMessageId: 'wire-decision', serial: 'serial-12' },
              { inputs: [{ kind: 'approval', payload: { messageId: 'ui-1', toolCallId: 'tc-1', approved: true } }] },
            ),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((message) => message.id)).toEqual(['ui-1']);
      expect(messages[0]?.events.at(-1)).toEqual({
        direction: 'input',
        event: { kind: 'approval', payload: { messageId: 'ui-1', toolCallId: 'tc-1', approved: true } },
      });
    });

    it('keeps an input naming a message this walk never saw', async () => {
      // Dropping it would lose a resolution the store may well hold the
      // assistant for.
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            messageEvent(
              { transportMessageId: 'wire-orphan', serial: 'serial-10' },
              { inputs: [{ kind: 'approval', payload: { messageId: 'gone', toolCallId: 'tc-9', approved: false } }] },
            ),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((message) => message.id)).toEqual(['gone']);
    });

    it('groups a regenerate under the wire message it arrived on', async () => {
      // `regenerate` names a message it does not belong to, so folding it into
      // that message would put an unrelated signal in the middle of it.
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            outputEvent('run-1', 'wire-a', assistantChunks('ui-1', 'hi'), 'serial-10'),
            runEndEvent('run-1'),
            messageEvent(
              { transportMessageId: 'wire-regen', serial: 'serial-11' },
              { inputs: [{ kind: 'regenerate', payload: { messageId: 'ui-1' } }] },
            ),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((message) => message.id)).toEqual(['ui-1', 'wire-regen']);
    });
  });

  describe('a walked message that names no id', () => {
    it('groups it under its wire id and reports it alongside the rest', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            // A delta with no opener, so nothing in the group names a message.
            // Whether the reducer can make anything of it is the application's
            // business; the walk reports what was published either way.
            outputEvent('run-1', 'wire-bad', [{ type: 'text-delta', id: 't1', delta: 'orphan' }], 'serial-11'),
            outputEvent('run-1', 'wire-a2', assistantChunks('a2', 'fine'), 'serial-12'),
            runEndEvent('run-1'),
          ],
          exhausted: true,
        },
      ];

      const { messages } = await chat.readSince();

      expect(messages.map((m) => m.id)).toEqual(['wire-bad', 'a2']);
    });
  });

  describe('a second readSince', () => {
    it('still reports the conversation the first walk paged', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'done'), 'serial-11'),
            runEndEvent('run-1'),
          ],
          exhausted: true,
        },
      ];
      const first = await chat.readSince();
      expect(first.messages.map((m) => m.id)).toEqual(['a1']);

      // The pager opens its cursor once and keeps it, so a second walk fetches
      // no pages. Reporting an empty conversation here would hand useChat a
      // blank history for a channel that has one, with no error to notice.
      const second = await chat.readSince();
      expect(second.messages.map((m) => m.id)).toEqual(['a1']);
      expect(second.exhausted).toBe(true);
    });

    it('keeps a withheld message when the run ends live between the walks', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-1', 'serial-10'),
            outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'done'), 'serial-11'),
          ],
          exhausted: true,
        },
      ];
      await chat.readSince();

      // The run's end arrives on the channel, which is the only way a walk
      // that already exhausted its cursor learns of it.
      fake.emit(runEndEvent('run-1'));
      await chat.readSince();

      // The retention survives, so the withheld message is still delivered and
      // the replayed terminal is what closes the stream.
      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual(assistantChunks('a1', 'done'));
    });

    it('delivers an event once when a re-walk overlaps the live buffer', async () => {
      const { fake, chat } = setup();
      const opener = outputEvent('run-1', 'wire-a1', [{ type: 'start', messageId: 'a1' }], 'serial-11');
      // The same event reaches the adapter live and then again from history.
      fake.emit(runStartEvent('run-1', 'serial-10'));
      fake.emit(opener);
      fake.historyBatches = [{ events: [runStartEvent('run-1', 'serial-10'), opener], exhausted: true }];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      fake.emit(runEndEvent('run-1'));

      // Delivered once, not twice: a duplicated opener would build the message
      // twice in useChat's reducer, which nothing can undo.
      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual([{ type: 'start', messageId: 'a1' }]);
    });
  });

  // -- reconnect -----------------------------------------------------------

  describe('reconnectToStream', () => {
    it('returns null before the walk has run', async () => {
      const { chat } = setup();
      // eslint-disable-next-line unicorn/no-null -- the SDK contract is null
      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBe(null);
    });

    it('returns null when the walk found no open run', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'done'), 'serial-11'), runEndEvent('run-1')],
          exhausted: true,
        },
      ];
      await chat.readSince();

      // eslint-disable-next-line unicorn/no-null -- the SDK contract is null
      expect(await chat.reconnectToStream({ chatId: 'ai:test' })).toBe(null);
    });

    it('replays the withheld message, then goes live', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-2', 'serial-20'),
            outputEvent(
              'run-2',
              'wire-a2',
              [
                { type: 'start', messageId: 'a2' },
                { type: 'text-start', id: 'a2-t' },
                { type: 'text-delta', id: 'a2-t', delta: 'The weather in' },
              ],
              'serial-21',
            ),
          ],
          exhausted: true,
        },
      ];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(stream).not.toBeNull();

      // The live append is the SAME wire message: the channel serial is
      // unchanged from the walked delivery and only the version advances.
      fake.emit(
        appendEvent(
          'run-2',
          'wire-a2',
          [{ type: 'text-delta', id: 'a2-t', delta: ' Berlin is 4C' }],
          'serial-21',
          'serial-21:2',
        ),
      );
      fake.emit(runEndEvent('run-2'));

      const chunks = await readAll(stream as ReadableStream<AI.UIMessageChunk>);
      expect(chunks).toEqual([
        { type: 'start', messageId: 'a2' },
        { type: 'text-start', id: 'a2-t' },
        { type: 'text-delta', id: 'a2-t', delta: 'The weather in' },
        { type: 'text-delta', id: 'a2-t', delta: ' Berlin is 4C' },
      ]);
    });

    it('replays every append buffered during the walk, not just the first', async () => {
      const { fake, chat } = setup();
      // A page that loads mid-stream: the decoder's first contact with the
      // message in flight emits an opener plus the text so far, and the reply
      // keeps arriving as appends of that SAME wire message while hydration
      // runs — one channel serial, an advancing version. All three land in the
      // live buffer, and the walk brings back only the run's start, because
      // the shared decoder has already incorporated the message itself.
      fake.emit(
        outputEvent(
          'run-2',
          'wire-a2',
          [
            { type: 'start', messageId: 'a2' },
            { type: 'text-start', id: 'a2-t' },
            { type: 'text-delta', id: 'a2-t', delta: 'The weather in' },
          ],
          'serial-21',
        ),
      );
      fake.emit(
        appendEvent('run-2', 'wire-a2', [{ type: 'text-delta', id: 'a2-t', delta: ' Berlin' }], 'serial-21', 'v-2'),
      );
      fake.emit(
        appendEvent('run-2', 'wire-a2', [{ type: 'text-delta', id: 'a2-t', delta: ' is 4C' }], 'serial-21', 'v-3'),
      );
      fake.historyBatches = [{ events: [runStartEvent('run-2', 'serial-20')], exhausted: true }];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      fake.emit(runEndEvent('run-2'));

      // Every delivery reaches the reducer. Keying the hand-off dedupe on the
      // channel serial would keep the first and drop the rest of the reply,
      // and no chunk in the UIMessageChunk union could put the text back.
      const chunks = await readAll(stream as ReadableStream<AI.UIMessageChunk>);
      expect(chunks).toEqual([
        { type: 'start', messageId: 'a2' },
        { type: 'text-start', id: 'a2-t' },
        { type: 'text-delta', id: 'a2-t', delta: 'The weather in' },
        { type: 'text-delta', id: 'a2-t', delta: ' Berlin' },
        { type: 'text-delta', id: 'a2-t', delta: ' is 4C' },
      ]);
    });

    it('still drops a delivery the walk and the live buffer both hold', async () => {
      const { fake, chat } = setup();
      const opener = outputEvent('run-2', 'wire-a2', [{ type: 'start', messageId: 'a2' }], 'serial-21');
      // The live buffer has been running since construction, so one delivery
      // can land there and come back from the walk as well. It must reach the
      // reducer once.
      fake.emit(opener);
      fake.historyBatches = [{ events: [runStartEvent('run-2', 'serial-20'), opener], exhausted: true }];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      fake.emit(runEndEvent('run-2'));

      const chunks = await readAll(stream as ReadableStream<AI.UIMessageChunk>);
      expect(chunks).toEqual([{ type: 'start', messageId: 'a2' }]);
    });

    it('closes cleanly when the run ended between the walk and the reconnect', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-2', 'serial-20'),
            outputEvent('run-2', 'wire-a2', [{ type: 'start', messageId: 'a2' }], 'serial-21'),
          ],
          exhausted: true,
        },
      ];
      const walk = chat.readSince();
      // The end lands in the walk's live buffer, because readSince subscribed
      // before it paged.
      fake.emit(runEndEvent('run-2'));
      await walk;

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual([{ type: 'start', messageId: 'a2' }]);
    });

    it('drops a superseded attempt from the replay', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-2', 'serial-20'),
            messageEvent(
              {
                runId: 'run-2',
                transportMessageId: 'wire-dead',
                role: 'assistant',
                serial: 'serial-21',
                stepId: 's1',
                stepStartSerial: 'serial-100',
              },
              { outputs: [{ type: 'text-delta', id: 't', delta: 'dead attempt' }] },
            ),
            messageEvent(
              {
                runId: 'run-2',
                transportMessageId: 'wire-live',
                role: 'assistant',
                serial: 'serial-22',
                stepId: 's1',
                stepStartSerial: 'serial-103',
              },
              { outputs: [{ type: 'text-delta', id: 't', delta: 'live attempt' }] },
            ),
          ],
          exhausted: true,
        },
      ];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      fake.emit(runEndEvent('run-2'));

      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual([
        { type: 'text-delta', id: 't', delta: 'live attempt' },
      ]);
    });

    it('resumes the run the application hints at', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-a', 'serial-20'),
            outputEvent('run-a', 'wire-aa', [{ type: 'start', messageId: 'aa' }], 'serial-21'),
            runStartEvent('run-b', 'serial-30'),
            outputEvent('run-b', 'wire-bb', [{ type: 'start', messageId: 'bb' }], 'serial-31'),
          ],
          exhausted: true,
        },
      ];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test', body: { runId: 'run-a' } });
      fake.emit(runEndEvent('run-a'));

      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual([{ type: 'start', messageId: 'aa' }]);
    });
  });

  // -- discovery, retention and repair -------------------------------------

  describe('resume discovery', () => {
    it('goes live on a run another participant started after the walk', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [outputEvent('run-1', 'wire-a1', assistantChunks('a1', 'done'), 'serial-11'), runEndEvent('run-1')],
          exhausted: true,
        },
      ];
      await chat.readSince();

      // Another client sends; this one is idle and hears the run open.
      fake.emit(runStartEvent('run-foreign', 'serial-30'));

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(stream).not.toBeNull();
      fake.emit(outputEvent('run-foreign', 'wire-af', assistantChunks('af', 'their reply'), 'serial-31'));
      fake.emit(runEndEvent('run-foreign'));

      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual(assistantChunks('af', 'their reply'));
    });

    it('still delivers a withheld message whose run ended before the reconnect', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-a', 'serial-20'),
            outputEvent('run-a', 'wire-aa', [{ type: 'start', messageId: 'aa' }], 'serial-21'),
            runStartEvent('run-b', 'serial-30'),
            outputEvent('run-b', 'wire-bb', [{ type: 'start', messageId: 'bb' }], 'serial-31'),
          ],
          exhausted: true,
        },
      ];
      await chat.readSince();

      // Resume the newer run, then watch the older one end behind us.
      const first = await chat.reconnectToStream({ chatId: 'ai:test' });
      fake.emit(runEndEvent('run-b'));
      await readAll(first as ReadableStream<AI.UIMessageChunk>);
      fake.emit(runEndEvent('run-a'));

      // run-a's message was withheld from the walk, so the stream is its only
      // producer. Losing it here would lose it until a page reload; the
      // replay carries the run's own end, so it closes cleanly.
      const second = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(second).not.toBeNull();
      expect(await readAll(second as ReadableStream<AI.UIMessageChunk>)).toEqual([{ type: 'start', messageId: 'aa' }]);
      expect(chat.streaming).toBe(false);
    });

    it('keeps live output that arrived before a run ended behind the walk', async () => {
      const { fake, chat } = setup();
      fake.historyBatches = [
        {
          events: [
            runStartEvent('run-a', 'serial-20'),
            outputEvent('run-a', 'wire-aa', [{ type: 'start', messageId: 'aa' }], 'serial-21'),
          ],
          exhausted: true,
        },
      ];
      await chat.readSince();

      // More of the run streams, and only then does it end. Both the deltas
      // and the terminal are live deliveries; the terminal is also appended to
      // the retention, so it exists twice.
      fake.emit(outputEvent('run-a', 'wire-aa', [{ type: 'text-start', id: 't1' }], 'serial-22'));
      fake.emit(outputEvent('run-a', 'wire-aa', [{ type: 'text-delta', id: 't1', delta: 'hi' }], 'serial-23'));
      fake.emit(runEndEvent('run-a'));

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });

      // Delivering a terminal closes the stream, so a replay that put the
      // retained copy ahead of these deltas would drop them silently and hand
      // useChat a truncated assistant message with no error.
      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual([
        { type: 'start', messageId: 'aa' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hi' },
      ]);
      expect(chat.streaming).toBe(false);
    });

    it('buffers events published before the walk runs', async () => {
      const { fake, chat } = setup();
      // The adapter is constructed, the application is still fetching its
      // store, and the agent is already streaming.
      fake.emit(runStartEvent('run-1', 'serial-20'));
      fake.emit(outputEvent('run-1', 'wire-a1', [{ type: 'start', messageId: 'a1' }], 'serial-21'));

      fake.historyBatches = [{ events: [], exhausted: true }];
      await chat.readSince();

      const stream = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(stream).not.toBeNull();
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(stream as ReadableStream<AI.UIMessageChunk>)).toEqual([{ type: 'start', messageId: 'a1' }]);
    });
  });

  describe('supersede repair', () => {
    it('replays only the canonical attempt after a live supersede', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const stream = await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();

      fake.emit(
        messageEvent(
          {
            runId: 'run-1',
            transportMessageId: 'wire-dead',
            serial: 'serial-101',
            stepId: 's1',
            stepStartSerial: 'serial-100',
          },
          { outputs: [{ type: 'text-delta', id: 't', delta: 'half a rep' }] },
        ),
      );
      fake.emit(stepStartEvent('run-1', 's1', 'serial-103'));
      await expect(readAll(stream)).rejects.toBeErrorInfoWithCode(ErrorCode.Conflict);

      // The consumer drops the damaged message and resumes; the replay must
      // carry the winning attempt only.
      fake.emit(
        messageEvent(
          {
            runId: 'run-1',
            transportMessageId: 'wire-live',
            serial: 'serial-104',
            stepId: 's1',
            stepStartSerial: 'serial-103',
          },
          { outputs: [{ type: 'text-delta', id: 't', delta: 'the whole reply' }] },
        ),
      );
      const repaired = await chat.reconnectToStream({ chatId: 'ai:test' });
      expect(repaired).not.toBeNull();
      fake.emit(runEndEvent('run-1'));

      expect(await readAll(repaired as ReadableStream<AI.UIMessageChunk>)).toEqual([
        { type: 'text-delta', id: 't', delta: 'the whole reply' },
      ]);
    });
  });

  // -- several clients on one channel --------------------------------------

  describe('onForeignRun', () => {
    it('fires for a run this client did not start', async () => {
      const { fake, chat } = setup();
      const seen: string[] = [];
      chat.onForeignRun((runId) => seen.push(runId));

      fake.emit(runStartEvent('run-someone-else'));
      await Promise.resolve();

      expect(seen).toEqual(['run-someone-else']);
    });

    it('stays quiet while this client is streaming', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const seen: string[] = [];
      chat.onForeignRun((runId) => seen.push(runId));

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();
      fake.emit(runStartEvent('run-someone-else'));

      expect(seen).toEqual([]);
    });

    it('keeps notifying when one callback throws', () => {
      const { fake, chat } = setup();
      const seen: string[] = [];
      chat.onForeignRun(() => {
        throw new Error('subscriber blew up');
      });
      chat.onForeignRun((runId) => seen.push(runId));

      fake.emit(runStartEvent('run-someone-else'));

      expect(seen).toEqual(['run-someone-else']);
    });

    it('unsubscribes', () => {
      const { fake, chat } = setup();
      const seen: string[] = [];
      const off = chat.onForeignRun((runId) => seen.push(runId));
      off();

      fake.emit(runStartEvent('run-someone-else'));

      expect(seen).toEqual([]);
    });
  });

  describe('onForeignInput', () => {
    it('reports a user turn another participant published', () => {
      const { fake, chat } = setup();
      const seen: VercelInput[] = [];
      chat.onForeignInput((input) => seen.push(input));

      fake.emit(
        messageEvent(
          { transportMessageId: 'cm-theirs' },
          { inputs: [{ kind: 'message', payload: userMessage('u9', 'hi from the other tab') }] },
        ),
      );

      expect(seen).toEqual([{ kind: 'message', payload: userMessage('u9', 'hi from the other tab') }]);
    });

    it('reports every input on one event, in wire order', () => {
      const { fake, chat } = setup();
      const seen: VercelInput[] = [];
      chat.onForeignInput((input) => seen.push(input));

      fake.emit(
        messageEvent(
          { transportMessageId: 'cm-theirs' },
          {
            inputs: [
              { kind: 'message', payload: userMessage('u9', 'part one') },
              { kind: 'message', payload: userMessage('u9', 'part two') },
            ],
          },
        ),
      );

      expect(seen.map((input) => (input.kind === 'message' ? input.payload.parts : undefined))).toEqual([
        [{ type: 'text', text: 'part one' }],
        [{ type: 'text', text: 'part two' }],
      ]);
    });

    it("stays quiet for the echo of this client's own send", async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const seen: VercelInput[] = [];
      chat.onForeignInput((input) => seen.push(input));

      const user = userMessage('u1', 'hello');
      await chat.sendMessages(sendOptions([user]));
      const own = fake.published[0]?.opts?.transportMessageId;
      expect(own).toBeTypeOf('string');
      fake.emit(messageEvent({ transportMessageId: own }, { inputs: [{ kind: 'message', payload: user }] }));

      expect(seen).toEqual([]);
    });

    it('stays quiet for the echo of a continuation, which shares the assistant id', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const seen: VercelInput[] = [];
      chat.onForeignInput((input) => seen.push(input));

      const assistant = approvedAssistant('a1');
      await chat.sendMessages(sendOptions([userMessage('u1', 'hi'), assistant], { messageId: 'a1' }));
      const own = fake.published[0]?.opts?.transportMessageId;
      fake.emit(
        messageEvent(
          { transportMessageId: own },
          { inputs: [{ kind: 'approval', payload: { messageId: 'a1', toolCallId: 'call-1', approved: true } }] },
        ),
      );

      expect(seen).toEqual([]);
    });

    it('reports a foreign input while this client is streaming its own run', async () => {
      stubChatFetch();
      const { fake, chat } = setup('run-1');
      const seen: VercelInput[] = [];
      chat.onForeignInput((input) => seen.push(input));

      await chat.sendMessages(sendOptions([userMessage('u1', 'hi')]));
      await Promise.resolve();
      fake.emit(
        messageEvent(
          { transportMessageId: 'cm-theirs' },
          { inputs: [{ kind: 'message', payload: userMessage('u9', 'meanwhile') }] },
        ),
      );

      expect(seen).toEqual([{ kind: 'message', payload: userMessage('u9', 'meanwhile') }]);
    });

    it('ignores an event carrying only output', () => {
      const { fake, chat } = setup();
      const seen: VercelInput[] = [];
      chat.onForeignInput((input) => seen.push(input));

      fake.emit(
        messageEvent({ transportMessageId: 'cm-theirs', runId: 'run-9' }, { outputs: assistantChunks('a9', 'reply') }),
      );

      expect(seen).toEqual([]);
    });

    it('keeps notifying when one callback throws', () => {
      const { fake, chat } = setup();
      const seen: VercelInput[] = [];
      chat.onForeignInput(() => {
        throw new Error('subscriber blew up');
      });
      chat.onForeignInput((input) => seen.push(input));

      fake.emit(
        messageEvent(
          { transportMessageId: 'cm-theirs' },
          { inputs: [{ kind: 'message', payload: userMessage('u9', 'hi') }] },
        ),
      );

      expect(seen).toHaveLength(1);
    });

    it('unsubscribes', () => {
      const { fake, chat } = setup();
      const seen: VercelInput[] = [];
      const off = chat.onForeignInput((input) => seen.push(input));
      off();

      fake.emit(
        messageEvent(
          { transportMessageId: 'cm-theirs' },
          { inputs: [{ kind: 'message', payload: userMessage('u9', 'hi') }] },
        ),
      );

      expect(seen).toEqual([]);
    });
  });
});
