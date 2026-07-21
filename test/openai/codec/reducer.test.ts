import type { Responses } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import type { CodecEvent, ReducerMeta } from '../../../src/core/codec/index.js';
import type { OpenAIInput, OpenAIOutput } from '../../../src/openai/codec/index.js';
import { fold, getMessages, init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import {
  completed,
  computerCallOutputItem,
  contentPartAdded,
  created,
  failed,
  firstInputText,
  fnArgsDelta,
  fnArgsDone,
  functionCallItem,
  functionCallOutputEvent,
  itemAdded,
  itemDone,
  messageItem,
  reasoningItem,
  reasoningSummaryPartAdded,
  reasoningSummaryTextDelta,
  reasoningSummaryTextDone,
  reasoningTextDelta,
  reasoningTextDone,
  reasoningTextPartAdded,
  refusalDelta,
  refusalDone,
  refusalPartAdded,
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

// Fold a sequence of [event, codec-message-id] pairs, so one run can carry
// several codec-message-ids — the multi-message path a run takes when the agent
// publishes each unit of work under its own pipe/send.
const foldOutputsById = (pairs: [OpenAIOutput, string][]): OpenAIProjection => {
  let state = init();
  for (const [event, messageId] of pairs) {
    const codecEvent: CodecEvent<OpenAIInput, OpenAIOutput> = { direction: 'output', event };
    state = fold(state, codecEvent, { serial: '', messageId });
  }
  return state;
};

const firstOutputText = (state: OpenAIProjection): string => {
  const message = getMessages(state)[0]?.message;
  const item = message?.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');
  const part = item?.content.find((p) => p.type === 'output_text');
  return part?.type === 'output_text' ? part.text : '';
};

const firstReasoningItem = (state: OpenAIProjection): Responses.ResponseReasoningItem | undefined =>
  getMessages(state)[0]?.message.items.find((i): i is Responses.ResponseReasoningItem => i.type === 'reasoning');

const firstMessage = (state: OpenAIProjection): Responses.ResponseOutputMessage | undefined =>
  getMessages(state)[0]?.message.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');

// Raw internal-projection reads — bypass the `getMessages` compaction to assert
// what the fold actually stored (used to show the projection deliberately keeps
// a sparse hole that `getMessages` hides).
const rawMessage = (state: OpenAIProjection): Responses.ResponseOutputMessage | undefined =>
  state.messages[0]?.message.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');

const rawReasoningItem = (state: OpenAIProjection): Responses.ResponseReasoningItem | undefined =>
  state.messages[0]?.message.items.find((i): i is Responses.ResponseReasoningItem => i.type === 'reasoning');

// Assert `arr` is a genuine two-slot leading hole: index 1 present, index 0 an
// actual gap (not an own key), as a backward partial load produces.
const expectLeadingHole = (arr: readonly unknown[] | undefined): void => {
  expect(arr).toHaveLength(2);
  expect(0 in (arr ?? [])).toBe(false);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAI reducer', () => {
  describe('init', () => {
    it('builds an empty projection that yields no messages', () => {
      const state = init();
      expect(state.messages).toHaveLength(0);
      expect(getMessages(state)).toHaveLength(0);
    });
  });

  describe('streaming accumulation', () => {
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

    it('folds a streamed reasoning summary into the reasoning item', () => {
      const state = foldOutputs([
        created(),
        itemAdded(reasoningItem('rs_1')),
        reasoningSummaryPartAdded('rs_1', 0),
        reasoningSummaryTextDelta('rs_1', 'Think'),
        reasoningSummaryTextDelta('rs_1', 'ing'),
        reasoningSummaryTextDone('rs_1', 'Thinking'),
        completed(),
      ]);

      expect(firstReasoningItem(state)?.summary).toEqual([{ type: 'summary_text', text: 'Thinking' }]);
    });

    it('folds a streamed refusal into the message content', () => {
      const state = foldOutputs([
        itemAdded(messageItem('msg_1')),
        refusalPartAdded('msg_1', 0),
        refusalDelta('msg_1', 'I can'),
        refusalDelta('msg_1', 'not help'),
        refusalDone('msg_1', 'I cannot help'),
      ]);

      expect(firstMessage(state)?.content).toEqual([{ type: 'refusal', refusal: 'I cannot help' }]);
    });

    it('folds streamed reasoning text into the reasoning item content', () => {
      const state = foldOutputs([
        itemAdded(reasoningItem('rs_1')),
        reasoningTextPartAdded('rs_1', 0),
        reasoningTextDelta('rs_1', 'be'),
        reasoningTextDelta('rs_1', 'cause'),
        reasoningTextDone('rs_1', 'because'),
      ]);

      expect(firstReasoningItem(state)?.content).toEqual([{ type: 'reasoning_text', text: 'because' }]);
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
  });

  describe('positional slotting by index', () => {
    it('keys reasoning summary parts by summary_index (concurrent parts of one item)', () => {
      // One reasoning item emits two summary parts; each delta must land in its own
      // slot, not the trailing one — the composite item_id + summary_index keying.
      const state = foldOutputs([
        itemAdded(reasoningItem('rs_1')),
        reasoningSummaryPartAdded('rs_1', 0),
        reasoningSummaryPartAdded('rs_1', 1),
        reasoningSummaryTextDelta('rs_1', 'first', 0),
        reasoningSummaryTextDelta('rs_1', 'second', 1),
        reasoningSummaryTextDone('rs_1', 'first', 0),
        reasoningSummaryTextDone('rs_1', 'second', 1),
      ]);

      expect(firstReasoningItem(state)?.summary).toEqual([
        { type: 'summary_text', text: 'first' },
        { type: 'summary_text', text: 'second' },
      ]);
    });

    it('keys output_text parts by content_index (multi-part message)', () => {
      // Two text parts on one message: each delta must land in its own slot, keyed
      // by content_index, not merged into a single trailing part.
      const state = foldOutputs([
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1', 0),
        contentPartAdded('msg_1', 1),
        textDelta('msg_1', 'first', 0),
        textDelta('msg_1', 'second', 1),
        textDone('msg_1', 'first', 0),
        textDone('msg_1', 'second', 1),
      ]);

      expect(firstMessage(state)?.content).toEqual([
        { type: 'output_text', text: 'first', annotations: [] },
        { type: 'output_text', text: 'second', annotations: [] },
      ]);
    });
  });

  // A run revealed while only partially folded (a history-straddling backward
  // page load) can deliver content_index=1 / summary_index=1 without index 0.
  // The reducer's positional slotting leaves a leading hole in the internal
  // projection, but `getMessages` compacts it to the dense-from-0 prefix on the
  // way out — so a consumer only ever sees a dense array, never an unannounced
  // `undefined` from a sparse slot. Because the hole is leading, the dense
  // prefix is empty until index 0 lands; the item is then returned with empty
  // content (indistinguishable from a freshly-added item), and fills whole once
  // the earlier index pages in. The Vercel codec is immune (id-keyed parts, no
  // positional slot to leave empty).
  describe('partial fold: positional hole compaction', () => {
    it('compacts a leading content_index hole to an empty prefix, leaving the projection holed', () => {
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1', 1),
        textDelta('msg_1', 'second', 1),
        textDone('msg_1', 'second', 1),
      ]);

      // getMessages exposes a dense (empty) content array — no hole reaches the consumer.
      expect(firstMessage(state)?.content).toEqual([]);

      // The internal projection still carries the sparse hole: compaction happens
      // at the read boundary, not in the fold.
      expectLeadingHole(rawMessage(state)?.content);
    });

    it('compacts a leading reasoning content_index hole to an empty prefix, leaving the projection holed', () => {
      const state = foldOutputs([
        created(),
        itemAdded(reasoningItem('rs_1')),
        reasoningTextPartAdded('rs_1', 1),
        reasoningTextDelta('rs_1', 'second', 1),
        reasoningTextDone('rs_1', 'second', 1),
      ]);

      expect(firstReasoningItem(state)?.content).toEqual([]);
      expectLeadingHole(rawReasoningItem(state)?.content);
    });

    it('compacts a leading summary_index hole to an empty prefix, leaving the projection holed', () => {
      const state = foldOutputs([
        created(),
        itemAdded(reasoningItem('rs_1')),
        reasoningSummaryPartAdded('rs_1', 1),
        reasoningSummaryTextDelta('rs_1', 'second', 1),
        reasoningSummaryTextDone('rs_1', 'second', 1),
      ]);

      expect(firstReasoningItem(state)?.summary).toEqual([]);
      expectLeadingHole(rawReasoningItem(state)?.summary);
    });

    it('truncates at the first hole, holding back later-index parts above a mid-array gap', () => {
      // Compaction holds back any slot above a hole, whatever the hole's
      // position — a present part can't be shown above a gap without either
      // re-introducing the gap or misplacing the part. A real partial load only
      // ever leaves a LEADING hole (parts publish in ascending index -> ascending
      // serial; history pages load newest-first), so this uses a middle gap
      // (index 0 and 2 present, 1 absent) to show the rule holds regardless:
      // index 2 is held back until index 1 fills, not surfaced above the gap.
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1', 0),
        textDone('msg_1', 'first', 0),
        contentPartAdded('msg_1', 2),
        textDone('msg_1', 'third', 2),
      ]);

      expect(firstMessage(state)?.content).toEqual([{ type: 'output_text', text: 'first', annotations: [] }]);
    });

    it('fills content whole once the earlier content_index folds', () => {
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        // The higher index pages in first (backward history load), then the earlier
        // one, re-densifying the projection as the WireLog refold would.
        contentPartAdded('msg_1', 1),
        textDone('msg_1', 'second', 1),
        contentPartAdded('msg_1', 0),
        textDone('msg_1', 'first', 0),
      ]);

      expect(firstMessage(state)?.content).toEqual([
        { type: 'output_text', text: 'first', annotations: [] },
        { type: 'output_text', text: 'second', annotations: [] },
      ]);
    });
  });

  describe('output_item.added', () => {
    it('is find-or-create by id: a repeated add does not double the item', () => {
      // The decode-lifecycle mid-stream-join repair can synthesise an
      // opening-bracket add that duplicates the real one. Two adds for one id
      // fold to a single item, and the deltas still accumulate into it.
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1'),
        textDelta('msg_1', 'hi'),
        textDone('msg_1', 'hi'),
        completed(),
      ]);

      expect(getMessages(state)[0]?.message.items).toHaveLength(1);
      expect(firstOutputText(state)).toBe('hi');
    });

    it('dedups regardless of order (synthetic opening bracket then real one)', () => {
      // On a reverse-order join (opening bracket synthesised on the stream, then the real
      // output_item.added paged in from history after it) the synthetic add lands
      // before the real one. Find-or-create keeps the first, so dedup holds
      // regardless of which add arrives first.
      const synthetic = messageItem('msg_1');
      const state = foldOutputs([
        created(),
        itemAdded(synthetic),
        contentPartAdded('msg_1'),
        textDelta('msg_1', 'hi'),
        textDone('msg_1', 'hi'),
        itemAdded(messageItem('msg_1')),
        completed(),
      ]);

      const messages = getMessages(state)[0]?.message.items.filter((i) => i.type === 'message') ?? [];
      expect(messages).toHaveLength(1);
      expect(firstOutputText(state)).toBe('hi');
    });

    it('skips an item type the codec does not model', () => {
      // A computer_call_output is a ResponseOutputItem member the codec does not
      // model (and one that is not a valid ResponseInputItem). An older subscriber
      // receiving it from a newer agent must tolerate it — skip it, not throw —
      // mirroring the decoder ignoring unknown event kinds. So it never enters a
      // message, keeping every stored item a valid model input. Message creation
      // is lazy: the skipped item adds nothing, so no message is created and
      // getMessages returns empty.
      const state = foldOutputs([itemAdded(computerCallOutputItem())]);
      expect(state.messages).toHaveLength(0);
      expect(getMessages(state)).toHaveLength(0);
    });
  });

  describe('output_item.done', () => {
    it('finalises the item status in place; content stays from the streams', () => {
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1'),
        textDelta('msg_1', 'partial'),
        textDone('msg_1', 'the full text'),
        // The output_item.done envelope is wire form: its own content is ignored — only the
        // terminal status is applied. The rendered text comes from the streams.
        itemDone({ ...messageItem('msg_1'), status: 'completed' }),
      ]);
      expect(getMessages(state)).toHaveLength(1);
      expect(firstOutputText(state)).toBe('the full text');
      expect(firstMessage(state)?.status).toBe('completed');
    });

    it("folds each output_text part's logprobs into its content slot by index", () => {
      // The wire-form output_item.done item carries per-part logprobs index-aligned with the
      // message content, so a logprobs-bearing output_text at content[1] folds
      // onto slot 1 — not onto the refusal at content[0], which stays untouched.
      const logprobs: Responses.ResponseOutputText['logprobs'] = [
        { token: 'Hi', logprob: -0.1, bytes: [72, 105], top_logprobs: [] },
      ];
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        refusalPartAdded('msg_1', 0),
        refusalDone('msg_1', 'no', 0),
        contentPartAdded('msg_1', 1),
        textDone('msg_1', 'Hi', 1),
        itemDone({
          ...messageItem('msg_1', [
            { type: 'refusal', refusal: 'no' },
            { type: 'output_text', text: 'Hi', annotations: [], logprobs },
          ]),
          status: 'completed',
        }),
      ]);
      const content = firstMessage(state)?.content;
      expect(content?.[0]).toEqual({ type: 'refusal', refusal: 'no' });
      const textPart = content?.[1];
      expect(textPart?.type === 'output_text' ? textPart.logprobs : undefined).toEqual(logprobs);
    });

    it('with no prior added is ignored (no opening bracket to finalise)', () => {
      // The wire-form output_item.done finalises an existing item's status; with no output_item.added there
      // is nothing to finalise, so nothing is folded.
      const state = foldOutputs([
        created(),
        itemDone(messageItem('orphan', [{ type: 'output_text', text: 'x', annotations: [] }])),
      ]);
      expect(getMessages(state)).toHaveLength(0);
    });

    it('without an id is ignored', () => {
      // A wire-form output_item.done matches its item by id; without one there is nothing to finalise.
      const idless: Responses.ResponseFunctionToolCall = {
        type: 'function_call',
        call_id: 'c1',
        name: 'f',
        arguments: '{}',
        status: 'completed',
      };
      const state = foldOutputs([created(), itemDone(idless)]);
      expect(getMessages(state)).toHaveLength(0);
    });

    it("sets a reasoning item's encrypted_content (done-only, never streamed)", () => {
      // encrypted_content is the stateless (store:false / ZDR) cross-turn carrier
      // of chain-of-thought and is never streamed, so the wire-form output_item.done envelope must
      // still deliver it. Seed the opening bracket via `added` WITHOUT the blob so this
      // asserts the output_item.done arm specifically.
      const state = foldOutputs([
        created(),
        itemAdded(reasoningItem('rs_1')),
        itemDone({ ...reasoningItem('rs_1', [], 'BLOB'), status: 'completed' }),
      ]);
      expect(firstReasoningItem(state)?.encrypted_content).toBe('BLOB');
      expect(firstReasoningItem(state)?.status).toBe('completed');
    });
  });

  describe('leniency: unopened slots and orphan events', () => {
    it('skips an output_text delta whose content_part.added was never folded', () => {
      // The reducer's input contract: the decoder always reconstructs a stream's
      // opener (content_part.added) before its deltas, even on a mid-stream join,
      // so a delta only ever mutates a slot its opener already seeded. This
      // sequence — a delta with no opener — can't arise through the real decoder;
      // the reducer skips it (a defensive no-op) rather than fabricating a slot,
      // unlike OpenAI's accumulator, which throws. (See the reducer's deviations.)
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        textDelta('msg_1', 'hi'),
        textDone('msg_1', 'hi'),
      ]);
      expect(firstMessage(state)?.content).toEqual([]);
    });

    // The other three resolvers share the output_text case's contract (a delta
    // only mutates an opener-seeded slot); these lock the same skip-not-fabricate
    // behaviour so a per-group regression to create-in-place can't slip through.
    it('skips a refusal delta whose content_part.added was never folded', () => {
      const state = foldOutputs([
        created(),
        itemAdded(messageItem('msg_1')),
        refusalDelta('msg_1', 'no'),
        refusalDone('msg_1', 'no'),
      ]);
      expect(firstMessage(state)?.content).toEqual([]);
    });

    it('skips a reasoning_text delta whose content_part.added was never folded', () => {
      const state = foldOutputs([
        created(),
        itemAdded(reasoningItem('rs_1')),
        reasoningTextDelta('rs_1', 'be'),
        reasoningTextDone('rs_1', 'because'),
      ]);
      expect(firstReasoningItem(state)?.content ?? []).toEqual([]);
    });

    it('skips a reasoning_summary_text delta whose reasoning_summary_part.added was never folded', () => {
      const state = foldOutputs([
        created(),
        itemAdded(reasoningItem('rs_1')),
        reasoningSummaryTextDelta('rs_1', 'Think'),
        reasoningSummaryTextDone('rs_1', 'Thinking'),
      ]);
      expect(firstReasoningItem(state)?.summary).toEqual([]);
    });

    it('drops a reasoning-summary delta routed to a non-reasoning item', () => {
      // The item is a message, not a reasoning item, so the summary fold is a no-op
      // (the isReasoningItem guard), leaving the message untouched.
      const state = foldOutputs([itemAdded(messageItem('msg_1')), reasoningSummaryTextDelta('msg_1', 'oops')]);
      expect(firstMessage(state)?.content).toEqual([]);
    });

    it('drops function-call arguments routed to a non-function-call item', () => {
      // arguments only apply to a function_call; on a message the fold is a no-op.
      const state = foldOutputs([itemAdded(messageItem('msg_1')), fnArgsDelta('msg_1', '{"x":1}')]);
      expect(firstMessage(state)?.content).toEqual([]);
    });

    it('drops a delta for an unknown item id (orphan)', () => {
      const state = foldOutputs([created(), textDelta('ghost', 'lost')]);
      expect(getMessages(state)).toHaveLength(0);
    });
  });

  describe('run outcome is not folded', () => {
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
  });

  describe('function calls', () => {
    it('folds streamed function-call arguments into the call item', () => {
      const state = foldOutputs([
        itemAdded(functionCallItem('fc_1', 'call_1', 'getWeather', '', 'in_progress')),
        fnArgsDelta('fc_1', '{"loc'),
        fnArgsDelta('fc_1', 'ation":"London"}'),
        fnArgsDone('fc_1', '{"location":"London"}', 'getWeather'),
      ]);

      const item = getMessages(state)[0]?.message.items.find(
        (i): i is Responses.ResponseFunctionToolCall => i.type === 'function_call',
      );
      expect(item?.arguments).toBe('{"location":"London"}');
      expect(item?.call_id).toBe('call_1');
    });

    it('folds a server-side function call and its output into one assistant message (shared codec-message-id)', () => {
      // The function_call rides the output_item envelopes (added seeds it, the
      // wire-form output_item.done finalises status); its arguments arrive on the stream. The agent
      // then publishes the tool result as the codec's own function_call_output event.
      const call = functionCallItem('fc_1', 'call_1', 'getWeather');
      const state = foldOutputs([
        created(),
        itemAdded(call),
        fnArgsDone('fc_1', '{"location":"London"}', 'getWeather'),
        itemDone({ ...call, arguments: '{"location":"London"}', status: 'completed' }),
        functionCallOutputEvent('call_1', '{"temperature":12}'),
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1'),
        textDelta('msg_1', 'It is 12°C in London.'),
        textDone('msg_1', 'It is 12°C in London.'),
        completed(),
      ]);

      const items = getMessages(state)[0]?.message.items ?? [];
      expect(items.map((i) => i.type)).toEqual(['function_call', 'function_call_output', 'message']);
      const callItem = items.find((i): i is Responses.ResponseFunctionToolCall => i.type === 'function_call');
      expect(callItem?.arguments).toBe('{"location":"London"}');
      expect(callItem?.status).toBe('completed');
      const output = items.find(
        (i): i is Responses.ResponseInputItem.FunctionCallOutput => i.type === 'function_call_output',
      );
      expect(output?.call_id).toBe('call_1');
      expect(output?.output).toBe('{"temperature":12}');
      expect(firstOutputText(state)).toBe('It is 12°C in London.');
    });

    it('appends a function_call_output even with no prior function_call folded', () => {
      // The reducer folds unconditionally; pairing with a call is a render concern.
      const state = foldOutputs([created(), functionCallOutputEvent('call_x', 'orphan')]);
      const items = getMessages(state)[0]?.message.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe('function_call_output');
    });
  });

  describe('user message', () => {
    it('folds a user-message input into a user message', () => {
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
      let state = fold(
        init(),
        { direction: 'input', event: { kind: 'user-message', message: userTurn('one ') } },
        meta,
      );
      state = fold(state, { direction: 'input', event: { kind: 'user-message', message: userTurn('two') } }, meta);

      const items = getMessages(state)[0]?.message.items ?? [];
      expect(items).toHaveLength(1);
      const message = items.find((i): i is Responses.ResponseInputItem.Message => i.type === 'message');
      const texts = message?.content.filter((p) => p.type === 'input_text').map((p) => p.text);
      expect(texts).toEqual(['one ', 'two']);
    });
  });

  // A single run can publish more than one codec-message-id (each pipe/send
  // mints one). The reducer keys messages by codec-message-id, find-or-create,
  // so one run's getMessages returns one OpenAIMessage per distinct id — the
  // same shape the Vercel reducer produces for a multi-message run.
  describe('multiple messages per run', () => {
    it('routes distinct codec-message-ids to distinct messages, in publication order', () => {
      const state = foldOutputsById([
        [created(), 'm1'],
        [itemAdded(messageItem('msg_1')), 'm1'],
        [contentPartAdded('msg_1'), 'm1'],
        [textDone('msg_1', 'first message'), 'm1'],
        // A second unit of work under its own codec-message-id → a second message.
        [itemAdded(messageItem('msg_2')), 'm2'],
        [contentPartAdded('msg_2'), 'm2'],
        [textDone('msg_2', 'second message'), 'm2'],
        [completed(), 'm2'],
      ]);

      const messages = getMessages(state);
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.codecMessageId)).toEqual(['m1', 'm2']);
      const text = (m: (typeof messages)[number] | undefined): string => {
        const item = m?.message.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');
        const part = item?.content.find((p) => p.type === 'output_text');
        return part?.type === 'output_text' ? part.text : '';
      };
      expect(text(messages[0])).toBe('first message');
      expect(text(messages[1])).toBe('second message');
    });

    it('folds function_call_output strictly by codec-message-id: call and output land in separate messages (rule B)', () => {
      // The function_call streams under one codec-message-id; the agent then
      // publishes the tool result on a fresh send (fresh id). Rule B routes every
      // event by its own codec-message-id with no call_id scan, so the output
      // lands in its own message, separate from the one holding the call. A
      // renderer pairs them by call_id across messages.
      const call = functionCallItem('fc_1', 'call_1', 'getWeather');
      const state = foldOutputsById([
        [created(), 'm1'],
        [itemAdded(call), 'm1'],
        [fnArgsDone('fc_1', '{"location":"London"}', 'getWeather'), 'm1'],
        [itemDone({ ...call, arguments: '{"location":"London"}', status: 'completed' }), 'm1'],
        // Tool output published on its own send → its own message.
        [functionCallOutputEvent('call_1', '{"temperature":12}'), 'm2'],
      ]);

      const messages = getMessages(state);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.message.items.map((i) => i.type)).toEqual(['function_call']);
      expect(messages[1]?.message.items.map((i) => i.type)).toEqual(['function_call_output']);
      const output = messages[1]?.message.items.find(
        (i): i is Responses.ResponseInputItem.FunctionCallOutput => i.type === 'function_call_output',
      );
      expect(output?.call_id).toBe('call_1');
    });
  });
});
