/**
 * Reducer unit tests.
 *
 * The Vercel reducer is a pure `(state, event, meta) -> state'` machine.
 * These tests validate purity, idempotency (serial dedup), and the codec-
 * local event folds (user-message merging, tool-approval transitions).
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { ReducerMeta } from '../../../src/core/codec/types.js';
import type { VercelEvent } from '../../../src/vercel/codec/events.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { fold, getMessages, init, type VercelProjection } from '../../../src/vercel/codec/reducer.js';

const meta = (serial: string, messageId?: string): ReducerMeta =>
  messageId === undefined ? { serial } : { serial, messageId };

/**
 * Build a baseline projection in which `toolCallId` is in the
 * `input-available` state — the precondition for `transitionToolPart`
 * to apply a `tool-output-available` transition.
 * @param toolCallId - Tool call identifier to seed.
 * @param messageId - msg-id to route the seeded events to.
 * @returns A projection with the tool call ready to receive an output.
 */
const seedToolCall = (toolCallId: string, messageId: string): VercelProjection => {
  let state = init();
  state = fold(
    state,
    { type: 'tool-input-start', toolCallId, toolName: 'echo', dynamic: true } as VercelEvent,
    meta('s0', messageId),
  );
  state = fold(
    state,
    { type: 'tool-input-available', toolCallId, toolName: 'echo', input: {}, dynamic: true } as VercelEvent,
    meta('s1', messageId),
  );
  return state;
};

describe('Vercel reducer', () => {
  // -- init ----------------------------------------------------------------

  describe('init', () => {
    it('returns an empty projection', () => {
      const state = init();
      expect(state.messages).toEqual([]);
      expect(state.conflictSerials.size).toBe(0);
      expect(state.trackers.size).toBe(0);
    });

    it('returns a fresh state on each call', () => {
      const a = init();
      const b = init();
      expect(a).not.toBe(b);
      expect(a.messages).not.toBe(b.messages);
      expect(a.conflictSerials).not.toBe(b.conflictSerials);
      expect(a.trackers).not.toBe(b.trackers);
    });
  });

  // -- getMessages ---------------------------------------------------------

  describe('getMessages', () => {
    it('returns the messages array from the projection', () => {
      const state = init();
      const msg: AI.UIMessage = { id: 'm-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      state.messages.push(msg);
      expect(getMessages(state)).toEqual([msg]);
    });
  });

  // -- conflict-key idempotency --------------------------------------------

  describe('conflict-key idempotency', () => {
    it('drops a duplicate conflicting event at the same serial', () => {
      let state = seedToolCall('tc-1', 'msg-1');
      const event: VercelEvent = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 1 },
        dynamic: true,
      };
      state = fold(state, event, meta('s2', 'msg-1'));
      const partAfterFirst = state.messages.find((m) => m.id === 'msg-1')?.parts.find((p) => p.type === 'dynamic-tool');
      state = fold(state, event, meta('s2', 'msg-1'));
      const partAfterSecond = state.messages
        .find((m) => m.id === 'msg-1')
        ?.parts.find((p) => p.type === 'dynamic-tool');
      // Idempotent: the part reference and contents are unchanged.
      expect(partAfterSecond).toBe(partAfterFirst);
    });

    it('highest-serial wins between conflicting events, regardless of arrival order', () => {
      const lower: VercelEvent = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 'lower' },
        dynamic: true,
      };
      const higher: VercelEvent = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 'higher' },
        dynamic: true,
      };

      // Forward order: lower then higher — higher overwrites.
      let forward = seedToolCall('tc-1', 'msg-1');
      forward = fold(forward, lower, meta('s2', 'msg-1'));
      forward = fold(forward, higher, meta('s3', 'msg-1'));
      const fwdPart = forward.messages
        .find((m) => m.id === 'msg-1')
        ?.parts.find((p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1');
      expect(fwdPart?.type === 'dynamic-tool' && fwdPart.state === 'output-available' && fwdPart.output).toEqual({
        v: 'higher',
      });

      // Reverse order: higher arrives first, lower arrives second and is dropped.
      let reverse = seedToolCall('tc-1', 'msg-1');
      reverse = fold(reverse, higher, meta('s3', 'msg-1'));
      reverse = fold(reverse, lower, meta('s2', 'msg-1'));
      const revPart = reverse.messages
        .find((m) => m.id === 'msg-1')
        ?.parts.find((p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1');
      expect(revPart?.type === 'dynamic-tool' && revPart.state === 'output-available' && revPart.output).toEqual({
        v: 'higher',
      });
    });

    it('does NOT drop unrelated events that happen to have a lower serial', () => {
      // Regression test: the old stream-wide watermark dropped any event
      // whose serial fell behind an unrelated earlier event. With per-key
      // dedup, a low-serial event for a fresh conflict key still lands.
      let state = init();

      // High-serial user-message advances the user-msg key only.
      state = fold(
        state,
        { type: 'ait-user-message', message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } },
        meta('s11'),
      );

      // Low-serial tool-input-start arrives later. Different conflict key —
      // should be folded.
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'echo', dynamic: true } as VercelEvent,
        meta('s10', 'm-asst'),
      );

      const assistant = state.messages.find((m) => m.id === 'm-asst');
      expect(assistant?.parts.find((p) => p.type === 'dynamic-tool')).toBeDefined();

      const user = state.messages.find((m) => m.id === 'u-1');
      expect(user?.role).toBe('user');
    });

    it('does NOT dedup additive content (text-delta repeats are upstream-handled)', () => {
      // text-delta has no conflict key — the reducer trusts upstream
      // ordering. Two distinct delta events accumulate.
      let state = init();
      state = fold(state, { type: 'text-start', id: 't-1' } as VercelEvent, meta('s1', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'hello ' } as VercelEvent, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'world' } as VercelEvent, meta('s3', 'msg-1'));
      const part = state.messages.find((m) => m.id === 'msg-1')?.parts.find((p) => p.type === 'text');
      expect(part?.type === 'text' && part.text).toBe('hello world');
    });

    it('records the highest serial per conflict key', () => {
      let state = init();
      state = fold(
        state,
        { type: 'ait-user-message', message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'a' }] } },
        meta('s1'),
      );
      state = fold(
        state,
        { type: 'ait-user-message', message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'b' }] } },
        meta('s5'),
      );
      // The key is `user-msg:u-1`; only s5 should be recorded.
      expect(state.conflictSerials.get('user-msg:u-1')).toBe('s5');
    });
  });

  // -- ait-user-message merging --------------------------------------------

  describe('ait-user-message merging', () => {
    it('inserts a user message that does not yet exist', () => {
      let state = init();
      const message: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] };
      const event: VercelEvent = { type: 'ait-user-message', message };

      state = fold(state, event, meta('s1'));

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual(message);
    });

    it('replaces a user message that shares the same id', () => {
      let state = init();
      const original: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'old' }] };
      const replacement: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'new' }] };

      state = fold(state, { type: 'ait-user-message', message: original }, meta('s1'));
      state = fold(state, { type: 'ait-user-message', message: replacement }, meta('s2'));

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual(replacement);
    });
  });

  // -- ait-tool-approval ---------------------------------------------------

  describe('ait-tool-approval', () => {
    it('transitions an existing dynamic-tool part on approve', () => {
      let state = init();
      // Fold a tool-input-available so a dynamic-tool part exists in input-available state.
      state = fold(
        state,
        {
          type: 'tool-input-start',
          toolCallId: 'tc-1',
          toolName: 'search',
        },
        meta('s1', 'msg-1'),
      );
      state = fold(
        state,
        {
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'search',
          input: { q: 'hi' },
        },
        meta('s2', 'msg-1'),
      );

      state = fold(state, { type: 'ait-tool-approval', toolCallId: 'tc-1', approved: true }, meta('s3'));

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart).toBeDefined();
      // approved transitions to tool-approval-request → approval-requested state
      expect(toolPart?.state).toBe('approval-requested');
    });

    it('transitions to output-denied on deny with reason', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        {
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'search',
          input: {},
        },
        meta('s2', 'msg-1'),
      );

      state = fold(
        state,
        { type: 'ait-tool-approval', toolCallId: 'tc-1', approved: false, reason: 'nope' },
        meta('s3'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-denied');
    });

    it('silently drops an approval for an unknown toolCallId (orphan)', () => {
      let state = init();
      const before = JSON.stringify(state.messages);
      state = fold(state, { type: 'ait-tool-approval', toolCallId: 'unknown', approved: true }, meta('s1'));
      expect(JSON.stringify(state.messages)).toBe(before);
    });
  });

  // -- UIMessageChunk fold (sample paths) ----------------------------------

  describe('UIMessageChunk fold', () => {
    it('drops chunks without a messageId in meta', () => {
      let state = init();
      // No messageId in meta → fold should be a no-op for chunks (nowhere to land).
      state = fold(state, { type: 'text-start', id: 'tx-1' }, meta('s1'));
      expect(state.messages).toHaveLength(0);
    });

    it('starts a text part and accumulates deltas', () => {
      let state = init();
      state = fold(state, { type: 'start' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'start-step' }, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-start', id: 'tx-1' }, meta('s3', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 'tx-1', delta: 'Hello' }, meta('s4', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 'tx-1', delta: ', world' }, meta('s5', 'msg-1'));
      state = fold(state, { type: 'text-end', id: 'tx-1' }, meta('s6', 'msg-1'));

      const message = state.messages.find((m) => m.id === 'msg-1');
      const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
      expect(textPart?.text).toBe('Hello, world');
    });
  });

  // -- Codec wiring --------------------------------------------------------

  describe('Codec wiring', () => {
    it('exposes init / fold / getMessages from UIMessageCodec', () => {
      let state = UIMessageCodec.init();
      const message: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      const event = UIMessageCodec.userMessageEvent(message);

      state = UIMessageCodec.fold(state, event, meta('s1'));
      expect(UIMessageCodec.getMessages(state)).toEqual([message]);
    });

    it('isTerminal returns true for finish, error and abort', () => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
      expect(UIMessageCodec.isTerminal({ type: 'finish', finishReason: 'stop' })).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
      expect(UIMessageCodec.isTerminal({ type: 'error', errorText: 'x' })).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
      expect(UIMessageCodec.isTerminal({ type: 'abort', reason: 'cancelled' })).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
      expect(UIMessageCodec.isTerminal({ type: 'start' })).toBe(false);
    });
  });

  // -- mutation semantics --------------------------------------------------

  describe('mutation semantics', () => {
    it('returns the same projection reference (in-place mutation is allowed)', () => {
      const state = init();
      const result: VercelProjection = fold(state, { type: 'start' }, meta('s1', 'msg-1'));
      expect(result).toBe(state);
    });
  });
});
