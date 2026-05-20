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

  // -- tool-approval-response -----------------------------------------------

  describe('tool-approval-response', () => {
    it('transitions an existing dynamic-tool part on approve and consumes the wire msg-id', () => {
      let state = init();
      // Fold a tool-input-available so a dynamic-tool part exists in input-available state.
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: { q: 'hi' } },
        meta('s2', 'msg-1'),
      );

      // The continuation publish carries its own wire msg-id; the reducer
      // redirects the response onto the assistant by toolCallId and marks
      // the continuation msg-id as consumed.
      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
        meta('s3', 'continuation-msg-id'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart).toBeDefined();
      // approved=true transitions to approval-responded so the AI SDK's
      // multi-step loop auto-runs the tool on the next step.
      expect(toolPart?.state).toBe('approval-responded');
      // The continuation wire msg-id is marked consumed — getMessages filters it out.
      expect(state.consumedMsgIds.has('continuation-msg-id')).toBe(true);
    });

    it('transitions to output-denied on deny with reason and consumes the wire msg-id', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: {} },
        meta('s2', 'msg-1'),
      );

      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: false, reason: 'nope' },
        meta('s3', 'continuation-msg-id'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-denied');
      expect(state.consumedMsgIds.has('continuation-msg-id')).toBe(true);
    });

    it('buffers an orphan approval until the assistant arrives, then promotes it', () => {
      let state = init();
      // Approval arrives before any assistant exists for tc-1 → buffer.
      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
        meta('s1', 'continuation-msg-id'),
      );
      expect(state.pendingToolResolutions).toHaveLength(1);
      expect(state.pendingToolResolutions[0]?.toolCallId).toBe('tc-1');
      // Wire msg-id not yet consumed — the resolution hasn't landed anywhere.
      expect(state.consumedMsgIds.has('continuation-msg-id')).toBe(false);

      // Late assistant arrival with the matching tool part — pending entry drains.
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s2', 'msg-1'));

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('approval-responded');
      expect(state.consumedMsgIds.has('continuation-msg-id')).toBe(true);
      expect(state.pendingToolResolutions).toHaveLength(0);
    });

    it('getMessages filters out consumed continuation msg-ids', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      // Seed a synthetic user-message at the continuation msg-id so we can
      // verify filtering: tool-resolution folds normally push the synthetic
      // role:user message into `messages`, but `getMessages` should hide it.
      state.messages.push({
        id: 'continuation-msg-id',
        role: 'user',
        parts: [{ type: 'text', text: 'irrelevant' }],
      });
      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
        meta('s3', 'continuation-msg-id'),
      );

      const visible = getMessages(state);
      expect(visible.find((m) => m.id === 'continuation-msg-id')).toBeUndefined();
      expect(visible.find((m) => m.id === 'msg-1')).toBeDefined();
    });

    // Option X: client stamps the prior assistant's `x-ably-msg-id` on the
    // continuation tool-resolution wire so the reducer's direct-fold branch
    // runs. The wire msg-id IS the owner's id, so it must NOT be consumed.
    it('folds approve directly when wire msg-id matches the owner — does not consume the owner', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: { q: 'hi' } },
        meta('s2', 'msg-1'),
      );

      // Wire msg-id stamped as the owner's id under Option X.
      state = fold(state, { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true }, meta('s3', 'msg-1'));

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('approval-responded');
      // Owner must remain visible — never consumed under Option X.
      expect(state.consumedMsgIds.has('msg-1')).toBe(false);
      expect(getMessages(state).find((m) => m.id === 'msg-1')).toBeDefined();
    });

    it('folds deny directly when wire msg-id matches the owner — does not consume the owner', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: {} },
        meta('s2', 'msg-1'),
      );

      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: false, reason: 'nope' },
        meta('s3', 'msg-1'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-denied');
      expect(state.consumedMsgIds.has('msg-1')).toBe(false);
    });
  });

  // -- tool-output-available / tool-output-error (continuation redirect) ---

  describe('tool-output-* UIMessageChunks via continuation redirect', () => {
    it('redirects tool-output-available onto the prior assistant by toolCallId and consumes the wire msg-id', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation' },
        meta('s1', 'msg-1'),
      );
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getLocation', input: { highAccuracy: true } },
        meta('s2', 'msg-1'),
      );

      // Wire msg-id 'continuation-msg-id-0' doesn't own the toolCallId —
      // the reducer redirects to msg-1 and consumes the continuation id.
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { latitude: 51.5, longitude: -0.1 } },
        meta('s3', 'continuation-msg-id-0'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
      if (toolPart?.state !== 'output-available') return;
      expect(toolPart.output).toEqual({ latitude: 51.5, longitude: -0.1 });
      expect(state.consumedMsgIds.has('continuation-msg-id-0')).toBe(true);
    });

    it('shares the tool-output conflict key — drops later duplicates', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation' },
        meta('s1', 'msg-1'),
      );
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getLocation', input: {} },
        meta('s2', 'msg-1'),
      );

      // First fold wins
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 1 } },
        meta('s3', 'continuation-msg-id-0'),
      );
      // Second fold at the same conflict key (toolCallId) drops because the
      // serial is not greater than the already-seen high-water-mark.
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 2 } },
        meta('s3', 'continuation-msg-id-1'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      if (toolPart?.state !== 'output-available') throw new Error('expected output-available');
      expect(toolPart.output).toEqual({ v: 1 });
    });

    it('redirects tool-output-error onto the prior assistant by toolCallId and consumes the wire msg-id', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation' },
        meta('s1', 'msg-1'),
      );
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getLocation', input: {} },
        meta('s2', 'msg-1'),
      );

      state = fold(
        state,
        { type: 'tool-output-error', toolCallId: 'tc-1', errorText: 'permission denied' },
        meta('s3', 'continuation-msg-id-0'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-error');
      if (toolPart?.state !== 'output-error') return;
      expect(toolPart.errorText).toBe('permission denied');
      expect(state.consumedMsgIds.has('continuation-msg-id-0')).toBe(true);
    });

    it('buffers an orphan tool-output until the assistant arrives, then promotes it', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 'x' } },
        meta('s1', 'continuation-msg-id-0'),
      );
      expect(state.pendingToolResolutions).toHaveLength(1);
      expect(state.consumedMsgIds.has('continuation-msg-id-0')).toBe(false);

      // Late assistant arrival with the matching tool part — pending entry drains.
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation' },
        meta('s2', 'msg-1'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
      expect(state.consumedMsgIds.has('continuation-msg-id-0')).toBe(true);
      expect(state.pendingToolResolutions).toHaveLength(0);
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
