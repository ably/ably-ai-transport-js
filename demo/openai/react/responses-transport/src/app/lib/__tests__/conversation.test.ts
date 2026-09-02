/**
 * Tests for the agent's conversation: it starts from the store plus the input
 * that woke the invocation — never channel history — records each batch the
 * run publishes as one message, and writes the whole thing back.
 *
 * The store is module-scoped, so each test uses its own channel name.
 */

import { describe, expect, it } from 'vitest';
import type { LocatedInput, WireMeta } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
import type { Responses } from 'openai/resources/responses/responses';

import { openConversation } from '../conversation';
import { loadConversation, saveConversation } from '../message-store';
import type { OpenAIInput } from '../openai-thread';
import type { ThreadMessage } from '../merge-thread';

const makeMeta = (overrides: Partial<WireMeta>): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: 's-1',
  transportMessageId: 'cm-1',
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: 1,
  role: undefined,
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  inputTransportMessageId: undefined,
  inputTransportMessageIds: undefined,
  steerTransportMessageIds: undefined,
  ...overrides,
});

const locatedPrompt = (transportMessageId: string, text: string): LocatedInput<OpenAIInput> => ({
  meta: makeMeta({ transportMessageId, role: 'user' }),
  inputs: [
    {
      kind: 'message',
      payload: { role: 'user', items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] },
    },
  ],
});

const storedReply = (transportMessageId: string, text: string): ThreadMessage => ({
  transportMessageId,
  role: 'assistant',
  items: [
    {
      id: `i-${transportMessageId}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
});

/** The opener a model turn's output item arrives under. */
const itemAdded = (item: Responses.ResponseOutputItem, outputIndex = 0): OpenAIOutput => ({
  type: 'response.output_item.added',
  item,
  output_index: outputIndex,
});

describe('openConversation', () => {
  it('starts from the store with the triggering input applied', async () => {
    await saveConversation('ai:conv-seed', { messages: [storedReply('cm-a0', 'earlier reply')] });

    const conversation = openConversation('ai:conv-seed', 'run-1', locatedPrompt('cm-u1', 'and now?'));

    expect(conversation.messages().map((message) => message.transportMessageId)).toEqual(['cm-a0', 'cm-u1']);
  });

  it('starts from the triggering input alone for a conversation with nothing stored', () => {
    const conversation = openConversation('ai:conv-fresh', 'run-1', locatedPrompt('cm-u1', 'hello'));

    expect(conversation.messages()).toHaveLength(1);
    expect(conversation.messages()[0]?.role).toBe('user');
  });

  it('records one published batch as one message', () => {
    const conversation = openConversation('ai:conv-record', 'run-1', locatedPrompt('cm-u1', 'hello'));

    conversation.record([
      itemAdded({
        id: 'i-a1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hi there', annotations: [] }],
      }),
    ]);

    expect(conversation.messages()).toHaveLength(2);
    expect(conversation.messages()[1]?.role).toBe('assistant');
  });

  it('records each batch as its own message, as each pipe is its own wire message', () => {
    const conversation = openConversation('ai:conv-batches', 'run-1', locatedPrompt('cm-u1', 'hello'));

    conversation.record([itemAdded({ id: 'i-a1', type: 'reasoning', summary: [] })]);
    conversation.record([
      itemAdded({
        id: 'i-a2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      }),
    ]);

    expect(conversation.messages()).toHaveLength(3);
  });

  it('records nothing for an empty batch', () => {
    const conversation = openConversation('ai:conv-empty-batch', 'run-1', locatedPrompt('cm-u1', 'hello'));

    conversation.record([]);

    expect(conversation.messages()).toHaveLength(1);
  });

  it('falls back to the trigger serial when no watermark is given', async () => {
    const conversation = openConversation('ai:conv-save', 'run-1', locatedPrompt('cm-u1', 'hello'));

    await conversation.save();

    const stored = loadConversation('ai:conv-save');
    expect(stored.messages.map((message) => message.transportMessageId)).toEqual(['cm-u1']);
    // The write as the run opens has no terminal to take a serial from, so the
    // trigger's is the conservative stand-in.
    expect(stored.latestSerial).toBe('s-1');
  });

  it("stores the watermark it is given, which is the run terminal's serial", async () => {
    const conversation = openConversation('ai:conv-watermark', 'run-1', locatedPrompt('cm-u1', 'hello'));

    await conversation.save('s-9');

    expect(loadConversation('ai:conv-watermark').latestSerial).toBe('s-9');
  });

  it('stamps the run on what it records, so a client knows which runs are covered', async () => {
    const conversation = openConversation('ai:conv-run-stamp', 'run-1', locatedPrompt('cm-u1', 'hello'));
    conversation.record([itemAdded({ id: 'i-a1', type: 'reasoning', summary: [] })]);

    await conversation.save();

    const stored = loadConversation('ai:conv-run-stamp');
    // The prompt is an input and carries no run; the recorded output does.
    expect(stored.messages.map((message) => message.runId)).toEqual([undefined, 'run-1']);
  });

  it('leaves the store untouched until save is called', async () => {
    const conversation = openConversation('ai:conv-deferred', 'run-1', locatedPrompt('cm-u1', 'hello'));
    conversation.record([itemAdded({ id: 'i-a1', type: 'reasoning', summary: [] })]);

    expect(loadConversation('ai:conv-deferred').messages).toEqual([]);

    await conversation.save();
    expect(loadConversation('ai:conv-deferred').messages).toHaveLength(2);
  });
});
