/**
 * Reducer unit tests.
 *
 * The Vercel reducer is a pure `(state, event, meta) -> state'` machine
 * folding the `VercelInput | VercelOutput` union. These tests validate
 * purity, idempotency (serial dedup), and the input folds
 * (user-message merging, tool-resolution transitions).
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { ReducerMeta } from '../../../src/core/codec/types.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { fold, getMessages, init, type VercelProjection } from '../../../src/vercel/codec/reducer.js';

const meta = (serial: string, messageId?: string): ReducerMeta =>
  messageId === undefined ? { serial } : { serial, messageId };

/**
 * Look up a reconstructed message by its codec-message-id — the only key
 * the SDK correlates on. `message.id` is preserved from the source and is
 * never used for lookup.
 * @param state - The projection to search.
 * @param codecMessageId - The codec-message-id to find.
 * @returns The reconstructed message, or undefined.
 */
const msgById = (state: VercelProjection, codecMessageId: string): AI.UIMessage | undefined =>
  state.messages.find((e) => e.codecMessageId === codecMessageId)?.message;

/**
 * Build a baseline projection in which `toolCallId` is in the
 * `input-available` state — the precondition for `transitionToolPart`
 * to apply a `tool-output-available` transition.
 * @param toolCallId - Tool call identifier to seed.
 * @param messageId - codec-message-id to route the seeded events to.
 * @returns A projection with the tool call ready to receive an output.
 */
const seedToolCall = (toolCallId: string, messageId: string): VercelProjection => {
  let state = init();
  state = fold(state, { type: 'tool-input-start', toolCallId, toolName: 'echo', dynamic: true }, meta('s0', messageId));
  state = fold(
    state,
    { type: 'tool-input-available', toolCallId, toolName: 'echo', input: {}, dynamic: true },
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
    it('returns the messages paired with their codec-message-ids', () => {
      const state = init();
      const msg: AI.UIMessage = { id: 'm-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      state.messages.push({ codecMessageId: 'cm-1', message: msg });
      expect(getMessages(state)).toEqual([{ codecMessageId: 'cm-1', message: msg }]);
    });
  });

  // -- conflict-key idempotency --------------------------------------------

  describe('conflict-key idempotency', () => {
    it('drops a duplicate conflicting event at the same serial', () => {
      let state = seedToolCall('tc-1', 'msg-1');
      const event: VercelOutput = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 1 },
        dynamic: true,
      };
      state = fold(state, event, meta('s2', 'msg-1'));
      const partAfterFirst = msgById(state, 'msg-1')?.parts.find((p) => p.type === 'dynamic-tool');
      state = fold(state, event, meta('s2', 'msg-1'));
      const partAfterSecond = msgById(state, 'msg-1')?.parts.find((p) => p.type === 'dynamic-tool');
      // Idempotent: the part reference and contents are unchanged.
      expect(partAfterSecond).toBe(partAfterFirst);
    });

    it('highest-serial wins between conflicting events, regardless of arrival order', () => {
      const lower: VercelOutput = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 'lower' },
        dynamic: true,
      };
      const higher: VercelOutput = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 'higher' },
        dynamic: true,
      };

      // Forward order: lower then higher — higher overwrites.
      let forward = seedToolCall('tc-1', 'msg-1');
      forward = fold(forward, lower, meta('s2', 'msg-1'));
      forward = fold(forward, higher, meta('s3', 'msg-1'));
      const fwdPart = msgById(forward, 'msg-1')?.parts.find(
        (p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1',
      );
      expect(fwdPart?.type === 'dynamic-tool' && fwdPart.state === 'output-available' && fwdPart.output).toEqual({
        v: 'higher',
      });

      // Reverse order: higher arrives first, lower arrives second and is dropped.
      let reverse = seedToolCall('tc-1', 'msg-1');
      reverse = fold(reverse, higher, meta('s3', 'msg-1'));
      reverse = fold(reverse, lower, meta('s2', 'msg-1'));
      const revPart = msgById(reverse, 'msg-1')?.parts.find(
        (p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1',
      );
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
      const userInput: VercelInput = {
        kind: 'user-message',
        message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      };
      state = fold(state, userInput, meta('s11'));

      // Low-serial tool-input-start arrives later. Different conflict key —
      // should be folded.
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'echo', dynamic: true },
        meta('s10', 'm-asst'),
      );

      const assistant = msgById(state, 'm-asst');
      expect(assistant?.parts.find((p) => p.type === 'dynamic-tool')).toBeDefined();

      const user = msgById(state, 'u-1');
      expect(user?.role).toBe('user');
    });

    it('does NOT dedup additive content (text-delta repeats are upstream-handled)', () => {
      // text-delta has no conflict key — the reducer trusts upstream
      // ordering. Two distinct delta events accumulate.
      let state = init();
      state = fold(state, { type: 'text-start', id: 't-1' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'hello ' }, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'world' }, meta('s3', 'msg-1'));
      const part = msgById(state, 'msg-1')?.parts.find((p) => p.type === 'text');
      expect(part?.type === 'text' && part.text).toBe('hello world');
    });

    it('records the highest serial per conflict key', () => {
      let state = init();
      const userA: VercelInput = {
        kind: 'user-message',
        message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'a' }] },
      };
      const userB: VercelInput = {
        kind: 'user-message',
        message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'b' }] },
      };
      // The conflict key derives from the wire codec-message-id, never the
      // domain `message.id` — both folds carry codec-message-id `cm-x`.
      state = fold(state, userA, meta('s1', 'cm-x'));
      state = fold(state, userB, meta('s5', 'cm-x'));
      expect(state.conflictSerials.get('user-msg:cm-x')).toBe('s5');
    });
  });

  // -- user-message merging ------------------------------------------------

  describe('user-message merging', () => {
    it('inserts a user message, preserving message.id while keying on the codec-message-id', () => {
      let state = init();
      // The domain id (`u-1`) differs from the wire codec-message-id (`cm-1`):
      // the entry is keyed on `cm-1` and `message.id` is preserved verbatim.
      const message: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] };
      const event: VercelInput = { kind: 'user-message', message };

      state = fold(state, event, meta('s1', 'cm-1'));

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual({ codecMessageId: 'cm-1', message });
      expect(state.messages[0]?.message.id).toBe('u-1');
    });

    it('replaces a user message that shares the same codec-message-id', () => {
      let state = init();
      const original: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'old' }] };
      const replacement: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'new' }] };

      state = fold(state, { kind: 'user-message', message: original }, meta('s1', 'cm-1'));
      state = fold(state, { kind: 'user-message', message: replacement }, meta('s2', 'cm-1'));

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual({ codecMessageId: 'cm-1', message: replacement });
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
      // redirects the response onto the assistant by codecMessageId+toolCallId
      // and marks the continuation codec-message-id as consumed.
      const approval: VercelInput = {
        kind: 'tool-approval-response',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        approved: true,
      };
      state = fold(state, approval, meta('s3', 'continuation-codec-message-id'));

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart).toBeDefined();
      // approved=true transitions to approval-responded so the AI SDK's
      // multi-step loop auto-runs the tool on the next step.
      expect(toolPart?.state).toBe('approval-responded');
      // The owner assistant message stays visible — no projection-side filtering.
      expect(msgById(state, 'msg-1')).toBeDefined();
    });

    it('transitions to output-denied on deny with reason', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: {} },
        meta('s2', 'msg-1'),
      );

      const denial: VercelInput = {
        kind: 'tool-approval-response',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        approved: false,
        reason: 'nope',
      };
      state = fold(state, denial, meta('s3', 'continuation-codec-message-id'));

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-denied');
      expect(msgById(state, 'msg-1')).toBeDefined();
    });

    it('buffers an orphan approval until the assistant arrives, then promotes it', () => {
      let state = init();
      // Approval arrives before any assistant exists for tc-1 → buffer.
      const approval: VercelInput = {
        kind: 'tool-approval-response',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        approved: true,
      };
      state = fold(state, approval, meta('s1', 'continuation-codec-message-id'));
      expect(state.pendingToolResolutions).toHaveLength(1);
      expect(state.pendingToolResolutions[0]?.toolCallId).toBe('tc-1');

      // Late assistant arrival with the matching tool part — pending entry drains.
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s2', 'msg-1'));

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('approval-responded');
      expect(state.pendingToolResolutions).toHaveLength(0);
    });
  });

  // -- tool-output / tool-output-error (client inputs that redirect) --------

  describe('tool-result / tool-result-error inputs', () => {
    it('redirects tool-result onto the prior assistant by codecMessageId+toolCallId', () => {
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

      const toolOutput: VercelInput = {
        kind: 'tool-result',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        output: { latitude: 51.5, longitude: -0.1 },
      };
      state = fold(state, toolOutput, meta('s3', 'continuation-codec-message-id-0'));

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
      if (toolPart?.state !== 'output-available') return;
      expect(toolPart.output).toEqual({ latitude: 51.5, longitude: -0.1 });
      // The owner assistant message stays visible — no projection-side filtering.
      expect(msgById(state, 'msg-1')).toBeDefined();
    });

    it('shares the tool-result conflict key — drops later duplicates', () => {
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

      const first: VercelInput = { kind: 'tool-result', codecMessageId: 'msg-1', toolCallId: 'tc-1', output: { v: 1 } };
      const second: VercelInput = {
        kind: 'tool-result',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        output: { v: 2 },
      };

      state = fold(state, first, meta('s3', 'continuation-codec-message-id-0'));
      // Second fold at the same conflict key (toolCallId) drops because the
      // serial is not greater than the already-seen high-water-mark.
      state = fold(state, second, meta('s3', 'continuation-codec-message-id-1'));

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      if (toolPart?.state !== 'output-available') throw new Error('expected output-available');
      expect(toolPart.output).toEqual({ v: 1 });
    });

    it('redirects tool-result-error onto the prior assistant by codecMessageId+toolCallId', () => {
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

      const errorInput: VercelInput = {
        kind: 'tool-result-error',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        message: 'permission denied',
      };
      state = fold(state, errorInput, meta('s3', 'continuation-codec-message-id-0'));

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-error');
      if (toolPart?.state !== 'output-error') return;
      expect(toolPart.errorText).toBe('permission denied');
      expect(msgById(state, 'msg-1')).toBeDefined();
    });

    it('buffers an orphan tool-result until the assistant arrives, then promotes it', () => {
      let state = init();
      const orphan: VercelInput = {
        kind: 'tool-result',
        codecMessageId: 'msg-1',
        toolCallId: 'tc-1',
        output: { v: 'x' },
      };
      state = fold(state, orphan, meta('s1', 'continuation-codec-message-id-0'));
      expect(state.pendingToolResolutions).toHaveLength(1);

      // Late assistant arrival with the matching tool part — pending entry drains.
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation' },
        meta('s2', 'msg-1'),
      );

      const message = msgById(state, 'msg-1');
      const toolPart = message?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
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

    it("preserves the stream's start.messageId as the assistant UIMessage.id, keyed on the codec-message-id", () => {
      let state = init();
      // The wire codec-message-id (`cm-1`) and the LLM stream id (`llm-1`)
      // differ. Subsequent chunks correlate on `cm-1`; the reconstructed
      // assistant carries the stream id `llm-1` so it round-trips verbatim.
      state = fold(state, { type: 'start', messageId: 'llm-1' }, meta('s1', 'cm-1'));
      state = fold(state, { type: 'text-start', id: 'tx-1' }, meta('s2', 'cm-1'));
      state = fold(state, { type: 'text-delta', id: 'tx-1', delta: 'hi' }, meta('s3', 'cm-1'));

      const assistant = msgById(state, 'cm-1');
      expect(assistant?.id).toBe('llm-1');
      expect(assistant?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text).toBe('hi');
    });

    it('falls back to the codec-message-id when the stream omits start.messageId', () => {
      let state = init();
      state = fold(state, { type: 'start' }, meta('s1', 'cm-1'));
      expect(msgById(state, 'cm-1')?.id).toBe('cm-1');
    });

    it('starts a text part and accumulates deltas', () => {
      let state = init();
      state = fold(state, { type: 'start' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'start-step' }, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-start', id: 'tx-1' }, meta('s3', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 'tx-1', delta: 'Hello' }, meta('s4', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 'tx-1', delta: ', world' }, meta('s5', 'msg-1'));
      state = fold(state, { type: 'text-end', id: 'tx-1' }, meta('s6', 'msg-1'));

      const message = msgById(state, 'msg-1');
      const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
      expect(textPart?.text).toBe('Hello, world');
    });
  });

  // -- agent tool-output attribution ----------------------------------------

  describe('agent tool-output attribution by toolCallId', () => {
    it('folds tool-output-available onto the owning message even under a different messageId', () => {
      // The original assistant (msg-1) holds the tool call. The approved-tool
      // continuation pass emits tool-output-available stamped with a FRESH
      // codec-message-id (msg-2). It must fold onto msg-1 by matching toolCallId.
      let state = seedToolCall('tc-1', 'msg-1');
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-1', output: { v: 42 }, dynamic: true },
        meta('s2', 'msg-2'),
      );

      // No phantom message created for the fresh id.
      expect(state.messages.map((e) => e.codecMessageId)).toEqual(['msg-1']);
      const part = state.messages[0]?.message.parts.find((p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1');
      expect(part?.type === 'dynamic-tool' && part.state).toBe('output-available');
      expect(part?.type === 'dynamic-tool' && part.state === 'output-available' && part.output).toEqual({ v: 42 });
    });

    it('folds tool-output-error onto the owning message even under a different messageId', () => {
      let state = seedToolCall('tc-1', 'msg-1');
      state = fold(
        state,
        { type: 'tool-output-error', toolCallId: 'tc-1', errorText: 'boom', dynamic: true },
        meta('s2', 'msg-2'),
      );

      expect(state.messages.map((e) => e.codecMessageId)).toEqual(['msg-1']);
      const part = state.messages[0]?.message.parts.find((p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1');
      expect(part?.type === 'dynamic-tool' && part.state).toBe('output-error');
      expect(part?.type === 'dynamic-tool' && part.state === 'output-error' && part.errorText).toBe('boom');
    });

    it('drops an orphan tool-output with no matching tool call and creates no message', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-output-available', toolCallId: 'tc-unknown', output: { v: 1 }, dynamic: true },
        meta('s1', 'msg-2'),
      );
      expect(state.messages).toHaveLength(0);
    });
  });

  // -- Codec wiring --------------------------------------------------------

  describe('Codec wiring', () => {
    it('exposes init / fold / getMessages from UIMessageCodec', () => {
      let state = UIMessageCodec.init();
      const message: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      const event = UIMessageCodec.createUserMessage(message);

      state = UIMessageCodec.fold(state, event, meta('s1', 'cm-1'));
      expect(UIMessageCodec.getMessages(state)).toEqual([{ codecMessageId: 'cm-1', message }]);
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
