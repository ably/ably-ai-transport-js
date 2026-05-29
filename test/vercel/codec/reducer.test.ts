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
import { dropMessages, fold, getMessages, init, type VercelProjection } from '../../../src/vercel/codec/reducer.js';

const meta = (serial: string, messageId?: string): ReducerMeta =>
  messageId === undefined ? { serial } : { serial, messageId };

/**
 * Read the `dynamic-tool` part for `toolCallId` on the message `msgId` from a
 * projection, narrowed so callers can read `.state`.
 * @param state - The projection to read.
 * @param msgId - The owning message id.
 * @param toolCallId - The tool call id to locate.
 * @returns The matching `dynamic-tool` part, or `undefined`.
 */
const toolPart = (state: VercelProjection, msgId: string, toolCallId: string): AI.DynamicToolUIPart | undefined =>
  getMessages(state)
    .find((m) => m.id === msgId)
    ?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool' && p.toolCallId === toolCallId);

/**
 * Fold a tool call into an existing projection at `messageId`, leaving it in
 * the `input-available` state. Lets a single (session-wide) projection carry
 * several independent tool calls across different messages.
 * @param state - Projection to fold into.
 * @param toolCallId - Tool call identifier to seed.
 * @param messageId - codec-message-id to route the seeded events to.
 * @param s0 - Serial for the tool-input-start event.
 * @param s1 - Serial for the tool-input-available event.
 * @returns The projection with the tool call ready to receive an output.
 */
const addToolCall = (
  state: VercelProjection,
  toolCallId: string,
  messageId: string,
  s0: string,
  s1: string,
): VercelProjection => {
  let next = fold(
    state,
    { type: 'tool-input-start', toolCallId, toolName: 'echo', dynamic: true },
    meta(s0, messageId),
  );
  next = fold(
    next,
    { type: 'tool-input-available', toolCallId, toolName: 'echo', input: {}, dynamic: true },
    meta(s1, messageId),
  );
  return next;
};

const seedToolCall = (toolCallId: string, messageId: string): VercelProjection =>
  addToolCall(init(), toolCallId, messageId, 's0', 's1');

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
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'echo', dynamic: true },
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
      state = fold(state, { type: 'text-start', id: 't-1' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'hello ' }, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'world' }, meta('s3', 'msg-1'));
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
    it('transitions an existing dynamic-tool part on approve and consumes the wire codec-message-id', () => {
      let state = init();
      // Fold a tool-input-available so a dynamic-tool part exists in input-available state.
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: { q: 'hi' } },
        meta('s2', 'msg-1'),
      );

      // The continuation publish carries its own wire codec-message-id; the reducer
      // redirects the response onto the assistant by toolCallId and marks
      // the continuation codec-message-id as consumed.
      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
        meta('s3', 'continuation-codec-message-id'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart).toBeDefined();
      // approved=true transitions to approval-responded so the AI SDK's
      // multi-step loop auto-runs the tool on the next step.
      expect(toolPart?.state).toBe('approval-responded');
      // The continuation wire codec-message-id is marked consumed — getMessages filters it out.
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id')).toBe(true);
    });

    it('transitions to output-denied on deny with reason and consumes the wire codec-message-id', () => {
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
        meta('s3', 'continuation-codec-message-id'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-denied');
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id')).toBe(true);
    });

    it('buffers an orphan approval until the assistant arrives, then promotes it', () => {
      let state = init();
      // Approval arrives before any assistant exists for tc-1 → buffer.
      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
        meta('s1', 'continuation-codec-message-id'),
      );
      expect(state.pendingToolResolutions).toHaveLength(1);
      expect(state.pendingToolResolutions[0]?.toolCallId).toBe('tc-1');
      // Wire codec-message-id not yet consumed — the resolution hasn't landed anywhere.
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id')).toBe(false);

      // Late assistant arrival with the matching tool part — pending entry drains.
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s2', 'msg-1'));

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('approval-responded');
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id')).toBe(true);
      expect(state.pendingToolResolutions).toHaveLength(0);
    });

    it('getMessages filters out consumed continuation codec-message-ids', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      // Seed a synthetic user-message at the continuation codec-message-id so we can
      // verify filtering: tool-resolution folds normally push the synthetic
      // role:user message into `messages`, but `getMessages` should hide it.
      state.messages.push({
        id: 'continuation-codec-message-id',
        role: 'user',
        parts: [{ type: 'text', text: 'irrelevant' }],
      });
      state = fold(
        state,
        { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
        meta('s3', 'continuation-codec-message-id'),
      );

      const visible = getMessages(state);
      expect(visible.find((m) => m.id === 'continuation-codec-message-id')).toBeUndefined();
      expect(visible.find((m) => m.id === 'msg-1')).toBeDefined();
    });

    // Option X: client stamps the prior assistant's `x-ably-codec-message-id` on the
    // continuation tool-resolution wire so the reducer's direct-fold branch
    // runs. The wire codec-message-id IS the owner's id, so it must NOT be consumed.
    it('folds approve directly when wire codec-message-id matches the owner — does not consume the owner', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: { q: 'hi' } },
        meta('s2', 'msg-1'),
      );

      // Wire codec-message-id stamped as the owner's id under Option X.
      state = fold(state, { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true }, meta('s3', 'msg-1'));

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('approval-responded');
      // Owner must remain visible — never consumed under Option X.
      expect(state.consumedCodecMessageIds.has('msg-1')).toBe(false);
      expect(getMessages(state).find((m) => m.id === 'msg-1')).toBeDefined();
    });

    it('folds deny directly when wire codec-message-id matches the owner — does not consume the owner', () => {
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
      expect(state.consumedCodecMessageIds.has('msg-1')).toBe(false);
    });
  });

  // -- tool-output-available / tool-output-error (continuation redirect) ---

  describe('tool-output-* UIMessageChunks via continuation redirect', () => {
    it('redirects tool-output-available onto the prior assistant by toolCallId and consumes the wire codec-message-id', () => {
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

      // Wire codec-message-id 'continuation-codec-message-id-0' doesn't own the toolCallId —
      // the reducer redirects to msg-1 and consumes the continuation id.
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { latitude: 51.5, longitude: -0.1 } },
        meta('s3', 'continuation-codec-message-id-0'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
      if (toolPart?.state !== 'output-available') return;
      expect(toolPart.output).toEqual({ latitude: 51.5, longitude: -0.1 });
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id-0')).toBe(true);
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
        meta('s3', 'continuation-codec-message-id-0'),
      );
      // Second fold at the same conflict key (toolCallId) drops because the
      // serial is not greater than the already-seen high-water-mark.
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 2 } },
        meta('s3', 'continuation-codec-message-id-1'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      if (toolPart?.state !== 'output-available') throw new Error('expected output-available');
      expect(toolPart.output).toEqual({ v: 1 });
    });

    it('redirects tool-output-error onto the prior assistant by toolCallId and consumes the wire codec-message-id', () => {
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
        meta('s3', 'continuation-codec-message-id-0'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-error');
      if (toolPart?.state !== 'output-error') return;
      expect(toolPart.errorText).toBe('permission denied');
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id-0')).toBe(true);
    });

    it('buffers an orphan tool-output until the assistant arrives, then promotes it', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 'x' } },
        meta('s1', 'continuation-codec-message-id-0'),
      );
      expect(state.pendingToolResolutions).toHaveLength(1);
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id-0')).toBe(false);

      // Late assistant arrival with the matching tool part — pending entry drains.
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation' },
        meta('s2', 'msg-1'),
      );

      const message = state.messages.find((m) => m.id === 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
      expect(state.consumedCodecMessageIds.has('continuation-codec-message-id-0')).toBe(true);
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

  // -- cross-run isolation (session-wide projection) -----------------------

  describe('cross-run isolation', () => {
    it('independent tool calls in different messages do not interfere', () => {
      // Two assistants (as if from two different Runs) folded into ONE
      // session-wide projection, each with its own tool call.
      let state = addToolCall(init(), 'tc-A', 'asst-A', 's0', 's1');
      state = addToolCall(state, 'tc-B', 'asst-B', 's2', 's3');

      // Resolve tc-A only.
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-A', output: { who: 'A' }, dynamic: true },
        meta('s10', 'asst-A'),
      );

      // tc-A resolved; tc-B untouched (still input-available).
      expect(toolPart(state, 'asst-A', 'tc-A')?.state).toBe('output-available');
      expect(toolPart(state, 'asst-B', 'tc-B')?.state).toBe('input-available');
    });

    it('a continuation tool-output resolves the matching assistant across messages', () => {
      // asst-A holds tc-A; a continuation output published under its own wire
      // id resolves onto asst-A by toolCallId — the cross-Run fold the shared
      // session projection makes natural — and the wire id is consumed.
      let state = addToolCall(init(), 'tc-A', 'asst-A', 's0', 's1');
      state = addToolCall(state, 'tc-B', 'asst-B', 's2', 's3');
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-A', output: { who: 'A' }, dynamic: true },
        meta('s10', 'cont-wire'),
      );

      expect(state.consumedCodecMessageIds.has('cont-wire')).toBe(true);
      expect(toolPart(state, 'asst-A', 'tc-A')?.state).toBe('output-available');
      // asst-B is untouched by the cross-message resolution.
      expect(toolPart(state, 'asst-B', 'tc-B')?.state).toBe('input-available');
    });
  });

  // -- dropMessages --------------------------------------------------------

  describe('dropMessages', () => {
    it('removes the named messages and leaves the rest, mutating in place', () => {
      let state = init();
      state = fold(state, { type: 'text-start', id: 't0' }, meta('s0', 'm-1'));
      state = fold(state, { type: 'text-delta', id: 't0', delta: 'one' }, meta('s1', 'm-1'));
      state = fold(state, { type: 'text-start', id: 't1' }, meta('s2', 'm-2'));
      state = fold(state, { type: 'text-delta', id: 't1', delta: 'two' }, meta('s3', 'm-2'));
      expect(getMessages(state).map((m) => m.id)).toEqual(['m-1', 'm-2']);

      const result = dropMessages(state, ['m-1']);
      expect(result).toBe(state);
      expect(getMessages(state).map((m) => m.id)).toEqual(['m-2']);
    });

    it('prunes the user-msg conflict serial even when the message id differs from the wire id', () => {
      // The reducer aligns the stored message id to the wire codec-message-id
      // (meta.messageId), and the Tree evicts by that wire id. The user-msg
      // conflict key must therefore be keyed on the wire id too, or its
      // high-water-mark would survive the eviction and wrongly suppress a
      // later re-fold.
      let state = init();
      state = fold(
        state,
        { type: 'ait-user-message', message: { id: 'domain-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } },
        meta('s1', 'wire-1'),
      );
      // Stored under the wire id, with a user-msg conflict serial.
      expect(getMessages(state).map((m) => m.id)).toEqual(['wire-1']);
      expect([...state.conflictSerials.keys()].some((k) => k.startsWith('user-msg:'))).toBe(true);

      dropMessages(state, ['wire-1']);

      expect(getMessages(state)).toEqual([]);
      expect([...state.conflictSerials.keys()].some((k) => k.startsWith('user-msg:'))).toBe(false);
    });

    it('prunes trackers and message-keyed conflict serials for the dropped message', () => {
      let state = init();
      state = fold(state, { type: 'text-start', id: 't0' }, meta('s0', 'm-1'));
      state = fold(state, { type: 'finish' }, meta('s1', 'm-1'));
      expect(state.trackers.has('m-1')).toBe(true);
      expect([...state.conflictSerials.keys()].some((k) => k.includes('m-1'))).toBe(true);

      dropMessages(state, ['m-1']);
      expect(state.trackers.has('m-1')).toBe(false);
      expect([...state.conflictSerials.keys()].some((k) => k.includes('m-1'))).toBe(false);
    });

    it("prunes tool-call-keyed conflict serials for the dropped message's tool calls", () => {
      let state = seedToolCall('tc-1', 'm-1');
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 1 }, dynamic: true },
        meta('s2', 'm-1'),
      );
      // tool-input-start:tc-1, tool-input-available:tc-1, tool-output:tc-1
      expect([...state.conflictSerials.keys()].some((k) => k.endsWith(':tc-1'))).toBe(true);

      dropMessages(state, ['m-1']);
      expect([...state.conflictSerials.keys()].some((k) => k.endsWith(':tc-1'))).toBe(false);
    });

    it('drops a consumed wire id', () => {
      // A continuation tool-output folds onto asst's tool call and consumes
      // its own wire id w-1.
      let state = seedToolCall('tc-1', 'asst');
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 1 }, dynamic: true },
        meta('s5', 'w-1'),
      );
      expect(state.consumedCodecMessageIds.has('w-1')).toBe(true);

      dropMessages(state, ['w-1']);
      expect(state.consumedCodecMessageIds.has('w-1')).toBe(false);
    });

    it('drops a pending tool resolution referencing the dropped wire id', () => {
      // No assistant has tc-orphan, so the output pends under wire id w-1.
      let state = init();
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-orphan', output: {}, dynamic: true },
        meta('s0', 'w-1'),
      );
      expect(state.pendingToolResolutions.some((p) => p.consumedCodecMessageId === 'w-1')).toBe(true);

      dropMessages(state, ['w-1']);
      expect(state.pendingToolResolutions.some((p) => p.consumedCodecMessageId === 'w-1')).toBe(false);
    });

    it('is a no-op for an empty id list or unknown ids', () => {
      let state = init();
      state = fold(state, { type: 'text-start', id: 't0' }, meta('s0', 'm-1'));
      const before = getMessages(state).map((m) => m.id);
      dropMessages(state, []);
      dropMessages(state, ['nonexistent']);
      expect(getMessages(state).map((m) => m.id)).toEqual(before);
    });
  });
});
