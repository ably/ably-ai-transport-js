/**
 * The drop-in criterion: the ChatTransport goes straight into `useChat` and
 * nothing else is needed to render a conversation — no companion hook, no
 * `setMessages` for anything the transport produces. Every message on screen
 * here arrived through one of the transport's streams.
 *
 * These tests instantiate a concrete `AbstractChat` subclass (what useChat
 * wraps) whose message state is mutated ONLY by the Chat's own state
 * callbacks, and drive two of the adapter's send paths — a fresh send and a
 * tool resolution, which opens a new run — plus a reload that walks history
 * and resumes the run still in flight.
 */

import type * as AI from 'ai';
import { AbstractChat, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { FakeClientTransport, messageEvent, runEndEvent, runStartEvent, stubChatFetch } from './helpers.js';

class TestChat extends AbstractChat<AI.UIMessage> {
  constructor(options: Omit<ConstructorParameters<typeof AbstractChat<AI.UIMessage>>[0], 'state'>) {
    const messages: AI.UIMessage[] = [];
    super({
      ...options,
      state: {
        status: 'ready',
        error: undefined,
        messages,
        pushMessage: (msg: AI.UIMessage) => messages.push(msg),
        popMessage: () => messages.pop(),
        replaceMessage: (i: number, msg: AI.UIMessage) => {
          messages[i] = msg;
        },
        snapshot: <T>(x: T) => structuredClone(x),
      },
    });
  }
}

/**
 * Let the Chat's own promise chains settle without leaning on wall-clock time.
 * The AbstractChat pipeline crosses macrotask boundaries (stream reads and
 * state callbacks), so a microtask flush alone is not enough; this yields the
 * event loop a few times rather than sleeping a magic duration.
 * @returns Resolves once the pipeline has had a chance to settle.
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('ChatTransport drives useChat with no external message state', () => {
  beforeEach(() => {
    stubChatFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a fresh send lands the assistant message through the stream alone', async () => {
    const fake = new FakeClientTransport();
    fake.autoRunId = 'run-1';
    const transport = createChatTransport({ transport: fake, channelName: 'ai:test' });
    const chat = new TestChat({ transport, generateId: () => 'u1' });

    const sendPromise = chat.sendMessage({ text: 'Hello' });
    await flush();
    fake.emit(
      messageEvent(
        { transportMessageId: 'wire-a1', runId: 'run-1', role: 'assistant' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Hi there' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: 'stop' },
          ],
        },
      ),
    );
    fake.emit(runEndEvent('run-1'));
    await sendPromise;

    expect(chat.status).toBe('ready');
    expect(chat.messages).toHaveLength(2);
    const assistant = chat.messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hi there' }));
  });

  it('a resolved tool publishes the output and the follow-up arrives on a new run', async () => {
    const fake = new FakeClientTransport();
    fake.autoRunId = 'run-1';
    const transport = createChatTransport({ transport: fake, channelName: 'ai:test' });
    const chat = new TestChat({
      transport,
      generateId: () => 'u1',
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    });

    // Round 1: the agent calls a client tool, then ends its run. The run has
    // done the work it was asked for; the conversation carries on in a new one.
    const sendPromise = chat.sendMessage({ text: 'Where am I?' });
    await flush();
    fake.emit(
      messageEvent(
        { transportMessageId: 'wire-a1', runId: 'run-1', role: 'assistant' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'start-step' },
            { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getLocation', dynamic: true },
            { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {}, dynamic: true },
          ],
        },
      ),
    );
    fake.emit(runEndEvent('run-1'));
    await sendPromise;

    // Round 2: the client resolves the tool. useChat resubmits automatically,
    // naming the assistant it resolved, and the adapter publishes the output
    // addressed by that message's own id with no run id on it.
    fake.autoRunId = 'run-2';
    const toolOutputPromise = chat.addToolOutput({
      tool: 'getLocation',
      toolCallId: 'call-1',
      output: { city: 'Berlin' },
    });
    await vi.waitFor(() => {
      expect(fake.published.some((p) => p.event.kind === 'chunk')).toBe(true);
    });
    const action = fake.published.find((p) => p.event.kind === 'chunk');
    expect(action?.event).toEqual({
      kind: 'chunk',
      payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { city: 'Berlin' }, dynamic: true },
    });
    expect(action?.opts).toEqual({ transportMessageId: 'a1' });

    await flush();
    fake.emit(
      messageEvent(
        { transportMessageId: 'wire-a2', runId: 'run-2', role: 'assistant' },
        {
          outputs: [
            { type: 'start', messageId: 'a2' },
            { type: 'start-step' },
            { type: 'text-start', id: 't2' },
            { type: 'text-delta', id: 't2', delta: 'You are in Berlin' },
            { type: 'text-end', id: 't2' },
            { type: 'finish-step' },
            { type: 'finish', finishReason: 'stop' },
          ],
        },
      ),
    );
    fake.emit(runEndEvent('run-2'));
    await toolOutputPromise;

    await vi.waitFor(() => {
      expect(chat.status).toBe('ready');
      expect(chat.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'You are in Berlin'))).toBe(
        true,
      );
    });
  });

  it('a reload walks history and resumes the run still in flight', async () => {
    const fake = new FakeClientTransport();
    fake.historyBatches = [
      {
        events: [
          runStartEvent('run-1'),
          messageEvent(
            { transportMessageId: 'wire-a1', runId: 'run-1', role: 'assistant' },
            {
              outputs: [
                { type: 'start', messageId: 'a1' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'partial ' },
              ],
            },
          ),
        ],
        exhausted: true,
      },
    ];
    const transport = createChatTransport({ transport: fake, channelName: 'ai:test' });
    const chat = new TestChat({ transport, generateId: () => 'u1' });

    // The application's hydration: walk, hand the finished messages to
    // setMessages, then resume. The walk withholds a1 because run-1 has not
    // ended, so the stream is that message's only producer.
    const { messages } = await transport.readSince();
    expect(messages).toEqual([]);

    const resumePromise = chat.resumeStream();
    await flush();
    fake.emit(
      messageEvent(
        { transportMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'text-delta', id: 't1', delta: 'and the rest' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: 'stop' },
          ],
        },
      ),
    );
    fake.emit(runEndEvent('run-1'));
    await resumePromise;

    expect(chat.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'partial and the rest'))).toBe(
      true,
    );
  });
});
