import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import type { CodecEvent, ReducerMeta } from '../../../src/core/codec/index.js';
import type { OpenAIInput, OpenAIOutput } from '../../../src/openai/codec/index.js';
import { fold, getMessages, init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import {
  completed,
  contentPartAdded,
  created,
  failed,
  firstInputText,
  itemAdded,
  itemDone,
  messageItem,
  streamError,
  textDelta,
  textDone,
  userTurn,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const foldOutputs = (events: OpenAIOutput[], messageId = 'run-1'): OpenAIProjection => {
  let state = init();
  const meta: ReducerMeta = { serial: '', messageId };
  for (const event of events) {
    const codecEvent: CodecEvent<OpenAIInput, OpenAIOutput> = { direction: 'output', event };
    state = fold(state, codecEvent, meta);
  }
  return state;
};

const firstOutputText = (state: OpenAIProjection): string => {
  const turn = getMessages(state)[0]?.message;
  const message = turn?.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');
  const part = message?.content.find((p) => p.type === 'output_text');
  return part?.type === 'output_text' ? part.text : '';
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAI reducer', () => {
  it('init builds an empty projection that yields no messages', () => {
    const state = init();
    expect(state.items).toHaveLength(0);
    expect(getMessages(state)).toHaveLength(0);
  });

  it('accumulates streamed text into a single assistant message', () => {
    const state = foldOutputs([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'Hello, '),
      textDelta('msg_1', 'world'),
      textDelta('msg_1', '!'),
      textDone('msg_1', 'Hello, world!'),
      completed(),
    ]);

    const messages = getMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.codecMessageId).toBe('run-1');
    expect(messages[0]?.message.role).toBe('assistant');
    expect(firstOutputText(state)).toBe('Hello, world!');
  });

  it('lazily creates the output_text part if content_part.added is missing', () => {
    // A delta arriving without its content_part.added (e.g. a future mid-stream
    // join before decodeLifecycle lands) still accumulates onto a synthesised part.
    const state = foldOutputs([
      created(),
      itemAdded(messageItem('msg_1')),
      textDelta('msg_1', 'hi'),
      textDone('msg_1', 'hi'),
    ]);
    expect(firstOutputText(state)).toBe('hi');
  });

  it('output_text.done replaces the accumulated text with the final value', () => {
    const state = foldOutputs([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'partial'),
      textDone('msg_1', 'the full text'),
    ]);
    expect(firstOutputText(state)).toBe('the full text');
  });

  it('output_item.done replaces the in-progress item with the final item', () => {
    const state = foldOutputs([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'partial'),
      itemDone(messageItem('msg_1', [{ type: 'output_text', text: 'final', annotations: [] }])),
    ]);
    expect(getMessages(state)).toHaveLength(1);
    expect(firstOutputText(state)).toBe('final');
  });

  it('output_item.done with no prior added appends the item', () => {
    const state = foldOutputs([
      created(),
      itemDone(messageItem('orphan', [{ type: 'output_text', text: 'x', annotations: [] }])),
    ]);
    const items = getMessages(state)[0]?.message.items ?? [];
    expect(items).toHaveLength(1);
    expect(firstOutputText(state)).toBe('x');
  });

  it('output_item.done for an item without an id appends it', () => {
    // A function-call item carries an optional id; one without an id cannot be
    // matched to a prior `added`, so it is appended.
    const idless: Responses.ResponseFunctionToolCall = {
      type: 'function_call',
      call_id: 'c1',
      name: 'f',
      arguments: '{}',
      status: 'completed',
    };
    const state = foldOutputs([created(), itemDone(idless)]);
    expect(getMessages(state)[0]?.message.items).toHaveLength(1);
  });

  it('drops a delta for an unknown item id (orphan)', () => {
    const state = foldOutputs([created(), textDelta('ghost', 'lost')]);
    expect(getMessages(state)).toHaveLength(0);
  });

  it('does not fold response.failed into items (run outcome is observed out-of-band)', () => {
    const state = foldOutputs([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'partial'),
      failed('boom'),
    ]);
    // The partial message survives untouched; the reducer fabricated nothing.
    expect(firstOutputText(state)).toBe('partial');
    expect(getMessages(state)[0]?.message.items).toHaveLength(1);
  });

  it('does not fold a stream-level error into items', () => {
    const state = foldOutputs([
      created(),
      itemAdded(messageItem('msg_1')),
      contentPartAdded('msg_1'),
      textDelta('msg_1', 'partial'),
      streamError('rate limited'),
    ]);
    expect(firstOutputText(state)).toBe('partial');
    expect(getMessages(state)[0]?.message.items).toHaveLength(1);
  });

  it('folds a user-message turn into a user message', () => {
    const userInput: CodecEvent<OpenAIInput, OpenAIOutput> = {
      direction: 'input',
      event: { kind: 'user-message', message: userTurn('what is the weather?') },
    };
    const state = fold(init(), userInput, { serial: '', messageId: 'u1' });

    const messages = getMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.role).toBe('user');
    expect(firstInputText(messages[0]?.message)).toBe('what is the weather?');
  });

  it('merges content parts delivered as separate inputs into one message', () => {
    // The input wire fans a user message out into one event per content part;
    // folding them under the same node accumulates one message with both parts.
    const meta: ReducerMeta = { serial: '', messageId: 'u1' };
    let state = fold(init(), { direction: 'input', event: { kind: 'user-message', message: userTurn('one ') } }, meta);
    state = fold(state, { direction: 'input', event: { kind: 'user-message', message: userTurn('two') } }, meta);

    const items = getMessages(state)[0]?.message.items ?? [];
    expect(items).toHaveLength(1);
    const message = items.find((i): i is Responses.ResponseInputItem.Message => i.type === 'message');
    const texts = message?.content.filter((p) => p.type === 'input_text').map((p) => p.text);
    expect(texts).toEqual(['one ', 'two']);
  });
});
