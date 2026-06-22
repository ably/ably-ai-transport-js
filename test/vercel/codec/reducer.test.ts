/**
 * Reducer unit tests.
 *
 * The Vercel reducer is a pure `(state, event, meta) -> state'` machine
 * folding the `VercelInput | VercelOutput` union. These tests validate
 * purity, the no-dedup fold contract (the transport sequences and dedups),
 * and the input folds (user-message merging, tool-resolution transitions).
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { CodecMessage, ReducerMeta } from '../../../src/core/codec/types.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { fold as foldEvent, getMessages, init, type VercelProjection } from '../../../src/vercel/codec/reducer.js';

const meta = (serial: string, messageId?: string): ReducerMeta =>
  messageId === undefined ? { serial } : { serial, messageId };

/**
 * Fold a bare fixture event, tagging it with its wire direction so the terse
 * call sites below need not spell out the `CodecEvent` wrapper. VercelInput
 * variants carry `kind`; VercelOutput variants carry `type`.
 * @param state - The projection to fold into.
 * @param event - The bare input or output event.
 * @param m - The reducer metadata (serial, optional messageId).
 * @returns The updated projection.
 */
const fold = (state: VercelProjection, event: VercelInput | VercelOutput, m: ReducerMeta): VercelProjection =>
  foldEvent(state, 'kind' in event ? { direction: 'input', event } : { direction: 'output', event }, m);

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
 * Locate the `dynamic-tool` part for a toolCallId within a message.
 * @param state - The projection to search.
 * @param codecMessageId - The codec-message-id owning the part.
 * @param toolCallId - The tool call to find.
 * @returns The dynamic-tool part, or undefined.
 */
const toolPartOf = (
  state: VercelProjection,
  codecMessageId: string,
  toolCallId: string,
): AI.DynamicToolUIPart | undefined =>
  msgById(state, codecMessageId)?.parts.find(
    (p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool' && p.toolCallId === toolCallId,
  );

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

/**
 * Text of the first text part in a message, if any.
 * @param msg - The message to read.
 * @returns The text, or undefined when the message has no text part.
 */
const textOf = (msg: AI.UIMessage): string | undefined =>
  msg.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;

/**
 * Text of the message at `index` in a materialised list (undefined if absent) —
 * a `!`-free indexed read for the continuation assertions.
 * @param msgs - The materialised message list.
 * @param index - The position to read.
 * @returns The message's text, or undefined.
 */
const textAt = (msgs: CodecMessage<AI.UIMessage>[], index: number): string | undefined => {
  const entry = msgs[index];
  return entry ? textOf(entry.message) : undefined;
};

/**
 * Build a base projection: user `u1`, then assistant `cm_tc` issuing an
 * unresolved client tool call `tc-1`. Folds carry no event-id, so everything
 * lands in the base node.
 * @returns The seeded base projection.
 */
const seedBaseWithToolCall = (): VercelProjection => {
  let state = init();
  state = fold(
    state,
    { kind: 'user-message', message: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'where am i?' }] } },
    meta('s0', 'u1'),
  );
  state = fold(
    state,
    { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'getLocation', dynamic: true },
    meta('s1', 'cm_tc'),
  );
  state = fold(
    state,
    { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getLocation', input: {}, dynamic: true },
    meta('s2', 'cm_tc'),
  );
  return state;
};

/**
 * Fold a client tool-result for `cm_tc` carrying its own wire event-id, then an
 * agent follow-up that echoes that event-id as `inputEventId` — one full
 * responder continuation.
 * @param state - The projection to fold into.
 * @param opts - The continuation's parameters.
 * @param opts.eventId - The triggering input event-id (the continuation key).
 * @param opts.serial - Serial prefix distinguishing this continuation's wires.
 * @param opts.output - The tool result output.
 * @param opts.followupId - Codec-message-id of the agent follow-up.
 * @param opts.answer - The follow-up's answer text.
 * @returns The updated projection.
 */
const addContinuation = (
  state: VercelProjection,
  opts: { eventId: string; serial: string; output: unknown; followupId: string; answer: string },
): VercelProjection => {
  let s = fold(
    state,
    { kind: 'tool-result', codecMessageId: 'cm_tc', payload: { toolCallId: 'tc-1', output: opts.output } },
    { serial: `r${opts.serial}`, messageId: `tr-${opts.eventId}`, eventId: opts.eventId },
  );
  s = fold(
    s,
    { type: 'start', messageId: opts.followupId },
    { serial: `f${opts.serial}`, messageId: opts.followupId, inputEventId: opts.eventId },
  );
  s = fold(
    s,
    { type: 'text-start', id: `tx-${opts.eventId}` },
    { serial: `f${opts.serial}a`, messageId: opts.followupId, inputEventId: opts.eventId },
  );
  s = fold(
    s,
    { type: 'text-delta', id: `tx-${opts.eventId}`, delta: opts.answer },
    { serial: `f${opts.serial}b`, messageId: opts.followupId, inputEventId: opts.eventId },
  );
  return s;
};

describe('Vercel reducer', () => {
  // -- init ----------------------------------------------------------------

  describe('init', () => {
    it('returns an empty projection', () => {
      const state = init();
      expect(state.messages).toEqual([]);
      expect(state.trackers.size).toBe(0);
    });

    it('returns a fresh state on each call', () => {
      const a = init();
      const b = init();
      expect(a).not.toBe(b);
      expect(a.messages).not.toBe(b.messages);
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

  // -- no reducer-level dedup ----------------------------------------------

  describe('no reducer-level dedup', () => {
    // The conflict-key high-water-mark gate is gone: the transport sequences
    // events canonically and delivers each exactly once, so the reducer folds
    // unconditionally and competing events resolve by fold order. These tests
    // pin the reducer's half of that contract; the transport-level
    // convergence (out-of-order refold, whole-wire replay drop) lives in
    // tree-vercel-sequencing.test.ts.

    it('folds competing events in call order — the last write wins', () => {
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
      // Canonical order delivers the lower serial first; the higher folds last
      // and overwrites. Out-of-order delivery is corrected by the transport's
      // refold before fold ever sees it.
      let state = seedToolCall('tc-1', 'msg-1');
      state = fold(state, lower, meta('s2', 'msg-1'));
      state = fold(state, higher, meta('s3', 'msg-1'));
      const part = toolPartOf(state, 'msg-1', 'tc-1');
      expect(part?.state === 'output-available' && part.output).toEqual({ v: 'higher' });
    });

    it('folds two same-key events delivered in one wire (same serial) — both apply, last wins', () => {
      // All events of one wire share a serial. The old gate's `<=` check
      // dropped the second; with the gate gone both fold in wire order.
      const first: VercelOutput = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 'first' },
        dynamic: true,
      };
      const second: VercelOutput = {
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { v: 'second' },
        dynamic: true,
      };
      let state = seedToolCall('tc-1', 'msg-1');
      state = fold(state, first, meta('s2', 'msg-1'));
      state = fold(state, second, meta('s2', 'msg-1'));
      const part = toolPartOf(state, 'msg-1', 'tc-1');
      expect(part?.state === 'output-available' && part.output).toEqual({ v: 'second' });
    });

    it('accumulates additive content (the reducer trusts the transport for ordering)', () => {
      let state = init();
      state = fold(state, { type: 'text-start', id: 't-1' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'hello ' }, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't-1', delta: 'world' }, meta('s3', 'msg-1'));
      const part = msgById(state, 'msg-1')?.parts.find((p) => p.type === 'text');
      expect(part?.type === 'text' && part.text).toBe('hello world');
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

    it('merges parts of a user message sharing the same codec-message-id', () => {
      let state = init();
      // A multi-part user message fans out into one wire event per part; the
      // reducer reassembles them by codec-message-id, in serial order.
      const textPart: AI.UIMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] };
      const filePart: AI.UIMessage = {
        id: 'u-1',
        role: 'user',
        parts: [{ type: 'file', mediaType: 'image/png', url: 'https://x/y.png' }],
      };

      state = fold(state, { kind: 'user-message', message: textPart }, meta('s1', 'cm-1'));
      state = fold(state, { kind: 'user-message', message: filePart }, meta('s2', 'cm-1'));

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]?.message.id).toBe('u-1');
      expect(state.messages[0]?.message.parts).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' },
      ]);
    });

    // Optimistic-seed reconciliation (seed folded with no serial, then its
    // echo re-delivers it with serials) is no longer the reducer's concern —
    // the transport refolds the node from its log on serial promotion, so the
    // seed never coexists with its echo. Proven in tree-vercel-sequencing.test.ts.
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
        payload: { toolCallId: 'tc-1', approved: true },
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
        payload: { toolCallId: 'tc-1', approved: false, reason: 'nope' },
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
        payload: { toolCallId: 'tc-1', approved: true },
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
        payload: { toolCallId: 'tc-1', output: { latitude: 51.5, longitude: -0.1 } },
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
        payload: { toolCallId: 'tc-1', message: 'permission denied' },
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
        payload: { toolCallId: 'tc-1', output: { v: 'x' } },
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

  // -- continuations (multi-responder client tool calls) -------------------

  describe('continuations', () => {
    it('routes a tool-result + follow-up into a continuation and materialises them', () => {
      let state = seedBaseWithToolCall();
      state = addContinuation(state, {
        eventId: 'E1',
        serial: '1',
        output: { city: 'London' },
        followupId: 'cm_fu1',
        answer: 'You are in London',
      });

      const msgs = getMessages(state);
      expect(msgs.map((m) => m.codecMessageId)).toEqual(['u1', 'cm_tc', 'cm_fu1']);
      const toolPart = msgs[1]?.message.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(toolPart?.state).toBe('output-available');
      if (toolPart?.state === 'output-available') expect(toolPart.output).toEqual({ city: 'London' });
      expect(textAt(msgs, 2)).toBe('You are in London');

      // The resolution lives in the continuation, NOT folded onto the base
      // assistant in place — the base tool call stays unresolved.
      expect(toolPartOf(state, 'cm_tc', 'tc-1')?.state).toBe('input-available');
      expect(state.continuations.size).toBe(1);
    });

    it('keeps two responders separate; canonical picks earliest, selector picks either', () => {
      let state = seedBaseWithToolCall();
      state = addContinuation(state, {
        eventId: 'E1',
        serial: '1',
        output: { city: 'London' },
        followupId: 'cm_fu1',
        answer: 'London',
      });
      state = addContinuation(state, {
        eventId: 'E2',
        serial: '2',
        output: { city: 'Paris' },
        followupId: 'cm_fu2',
        answer: 'Paris',
      });

      expect(state.continuations.size).toBe(2);

      // Canonical (no selector) → earliest by seeding serial → E1.
      const canonical = getMessages(state);
      expect(canonical.map((m) => m.codecMessageId)).toEqual(['u1', 'cm_tc', 'cm_fu1']);
      expect(textAt(canonical, 2)).toBe('London');

      // Selector → E2's branch; never the sibling's follow-up.
      const scopedToE2 = getMessages(state, { continuationEventId: 'E2' });
      expect(scopedToE2.map((m) => m.codecMessageId)).toEqual(['u1', 'cm_tc', 'cm_fu2']);
      expect(textAt(scopedToE2, 2)).toBe('Paris');
      const e2Tool = scopedToE2[1]?.message.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      if (e2Tool?.state === 'output-available') expect(e2Tool.output).toEqual({ city: 'Paris' });
    });

    it('scopes an agent to its own continuation, ending at the tool result (Problem 2)', () => {
      // Both tool-results have landed but neither follow-up yet — the moment an
      // agent reconstructs history before generating. Each must see ONLY its
      // own result, with the conversation ending at that (a user-role turn),
      // never a sibling's assistant follow-up (which would be a prefill error).
      let state = seedBaseWithToolCall();
      state = fold(
        state,
        { kind: 'tool-result', codecMessageId: 'cm_tc', payload: { toolCallId: 'tc-1', output: { city: 'London' } } },
        { serial: 'r1', messageId: 'tr-E1', eventId: 'E1' },
      );
      state = fold(
        state,
        { kind: 'tool-result', codecMessageId: 'cm_tc', payload: { toolCallId: 'tc-1', output: { city: 'Paris' } } },
        { serial: 'r2', messageId: 'tr-E2', eventId: 'E2' },
      );

      const forE2 = getMessages(state, { continuationEventId: 'E2' });
      expect(forE2.map((m) => m.codecMessageId)).toEqual(['u1', 'cm_tc']);
      const tool = forE2[1]?.message.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      expect(tool?.state).toBe('output-available');
      if (tool?.state === 'output-available') expect(tool.output).toEqual({ city: 'Paris' });
    });

    it('nests continuations for a multi-step client-tool sequence', () => {
      // cm_tc → result(E1) → follow-up cm_fu1 which ITSELF issues a client tool
      // call tc-2 → result(E1a) → follow-up cm_fu2.
      let state = seedBaseWithToolCall();
      state = fold(
        state,
        { kind: 'tool-result', codecMessageId: 'cm_tc', payload: { toolCallId: 'tc-1', output: { city: 'London' } } },
        { serial: 'r1', messageId: 'tr-E1', eventId: 'E1' },
      );
      // Follow-up cm_fu1 (in continuation E1) streams a second client tool call.
      state = fold(
        state,
        { type: 'start', messageId: 'cm_fu1' },
        { serial: 'f1', messageId: 'cm_fu1', inputEventId: 'E1' },
      );
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-2', toolName: 'getWeather', dynamic: true },
        { serial: 'f2', messageId: 'cm_fu1', inputEventId: 'E1' },
      );
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-2', toolName: 'getWeather', input: {}, dynamic: true },
        { serial: 'f3', messageId: 'cm_fu1', inputEventId: 'E1' },
      );
      // Resolve tc-2 — opens a CHILD continuation under E1, keyed E1a.
      state = fold(
        state,
        { kind: 'tool-result', codecMessageId: 'cm_fu1', payload: { toolCallId: 'tc-2', output: { temp: 12 } } },
        { serial: 'r2', messageId: 'tr-E1a', eventId: 'E1a' },
      );
      // Final follow-up cm_fu2 echoes E1a.
      state = fold(
        state,
        { type: 'start', messageId: 'cm_fu2' },
        { serial: 'g1', messageId: 'cm_fu2', inputEventId: 'E1a' },
      );
      state = fold(state, { type: 'text-start', id: 'gz' }, { serial: 'g2', messageId: 'cm_fu2', inputEventId: 'E1a' });
      state = fold(
        state,
        { type: 'text-delta', id: 'gz', delta: '12 degrees' },
        { serial: 'g3', messageId: 'cm_fu2', inputEventId: 'E1a' },
      );

      const msgs = getMessages(state);
      expect(msgs.map((m) => m.codecMessageId)).toEqual(['u1', 'cm_tc', 'cm_fu1', 'cm_fu2']);
      // cm_tc resolved to London, cm_fu1's tc-2 resolved to the weather, cm_fu2 the answer.
      const cmTcTool = msgs[1]?.message.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      if (cmTcTool?.state === 'output-available') expect(cmTcTool.output).toEqual({ city: 'London' });
      const fu1Tool = msgs[2]?.message.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
      if (fu1Tool?.state === 'output-available') expect(fu1Tool.output).toEqual({ temp: 12 });
      expect(textAt(msgs, 3)).toBe('12 degrees');
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

  // -- content-part folds (file / source-url / source-document) -------------

  describe('content-part folds', () => {
    it('appends a file part', () => {
      let state = init();
      state = fold(state, { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' }, meta('s1', 'msg-1'));
      expect(msgById(state, 'msg-1')?.parts).toEqual([
        { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' },
      ]);
    });

    it('appends a source-url part, stripping an absent title and keeping a present one', () => {
      let state = init();
      state = fold(state, { type: 'source-url', sourceId: 'su-1', url: 'https://a' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'source-url', sourceId: 'su-2', url: 'https://b', title: 'B' }, meta('s2', 'msg-1'));
      const parts = msgById(state, 'msg-1')?.parts;
      // Absent title is stripped — no `title` key — while a present one is kept.
      expect(parts?.[0]).toEqual({ type: 'source-url', sourceId: 'su-1', url: 'https://a' });
      expect(parts?.[1]).toEqual({ type: 'source-url', sourceId: 'su-2', url: 'https://b', title: 'B' });
    });

    it('appends a source-document part, stripping an absent filename', () => {
      let state = init();
      state = fold(
        state,
        { type: 'source-document', sourceId: 'sd-1', mediaType: 'application/pdf', title: 'Doc', filename: 'doc.pdf' },
        meta('s1', 'msg-1'),
      );
      state = fold(
        state,
        { type: 'source-document', sourceId: 'sd-2', mediaType: 'text/plain', title: 'Plain' },
        meta('s2', 'msg-1'),
      );
      const parts = msgById(state, 'msg-1')?.parts;
      expect(parts?.[0]).toEqual({
        type: 'source-document',
        sourceId: 'sd-1',
        mediaType: 'application/pdf',
        title: 'Doc',
        filename: 'doc.pdf',
      });
      expect(parts?.[1]).toEqual({
        type: 'source-document',
        sourceId: 'sd-2',
        mediaType: 'text/plain',
        title: 'Plain',
      });
    });

    it('appends each content part independently — never dedups', () => {
      let state = init();
      state = fold(state, { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' }, meta('s2', 'msg-1'));
      expect(msgById(state, 'msg-1')?.parts).toHaveLength(2);
    });
  });

  // -- data-* part folds ----------------------------------------------------

  describe('data-part folds', () => {
    it('drops a transient data part without creating a message', () => {
      let state = init();
      state = fold(state, { type: 'data-weather', data: { temp: 1 }, transient: true }, meta('s1', 'msg-1'));
      expect(state.messages).toHaveLength(0);
    });

    it('appends a persistent data part, stripping an absent id', () => {
      let state = init();
      state = fold(state, { type: 'data-weather', data: { temp: 1 } }, meta('s1', 'msg-1'));
      expect(msgById(state, 'msg-1')?.parts).toEqual([{ type: 'data-weather', data: { temp: 1 } }]);
    });

    it('replaces a data part in place when the id matches', () => {
      let state = init();
      state = fold(state, { type: 'data-weather', id: 'd-1', data: { temp: 1 } }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'data-weather', id: 'd-1', data: { temp: 2 } }, meta('s2', 'msg-1'));
      const parts = msgById(state, 'msg-1')?.parts;
      expect(parts).toHaveLength(1);
      expect(parts?.[0]).toEqual({ type: 'data-weather', id: 'd-1', data: { temp: 2 } });
    });

    it('appends rather than replaces when the id differs', () => {
      let state = init();
      state = fold(state, { type: 'data-weather', id: 'd-1', data: { temp: 1 } }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'data-weather', id: 'd-2', data: { temp: 2 } }, meta('s2', 'msg-1'));
      expect(msgById(state, 'msg-1')?.parts).toHaveLength(2);
    });
  });

  // -- tool-input streaming folds -------------------------------------------

  describe('tool-input streaming folds', () => {
    it('accumulates input-text deltas and parses JSON only once it is complete', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search', dynamic: true },
        meta('s1', 'msg-1'),
      );

      // First fragment is incomplete JSON → parse fails → input stays undefined.
      state = fold(
        state,
        { type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q":' },
        meta('s2', 'msg-1'),
      );
      const mid = toolPartOf(state, 'msg-1', 'tc-1');
      expect(mid?.state).toBe('input-streaming');
      if (mid?.state !== 'input-streaming') throw new Error('expected input-streaming');
      expect(mid.input).toBeUndefined();

      // Second fragment completes the JSON → input parses.
      state = fold(
        state,
        { type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '"hi"}' },
        meta('s3', 'msg-1'),
      );
      const done = toolPartOf(state, 'msg-1', 'tc-1');
      expect(done?.state).toBe('input-streaming');
      if (done?.state !== 'input-streaming') throw new Error('expected input-streaming');
      expect(done.input).toEqual({ q: 'hi' });
    });

    it('ignores a tool-input-delta for an unknown tool call', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-delta', toolCallId: 'tc-x', inputTextDelta: '{}' }, meta('s1', 'msg-1'));
      expect(msgById(state, 'msg-1')?.parts ?? []).toHaveLength(0);
    });

    it('transitions to input-available with the resolved input', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: { q: 'done' } },
        meta('s2', 'msg-1'),
      );
      const part = toolPartOf(state, 'msg-1', 'tc-1');
      expect(part?.state).toBe('input-available');
      if (part?.state !== 'input-available') throw new Error('expected input-available');
      expect(part.input).toEqual({ q: 'done' });
    });

    it('transitions an existing part to output-error on tool-input-error', () => {
      let state = init();
      state = fold(state, { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' }, meta('s1', 'msg-1'));
      state = fold(
        state,
        { type: 'tool-input-error', toolCallId: 'tc-1', toolName: 'search', input: { q: 'x' }, errorText: 'bad input' },
        meta('s2', 'msg-1'),
      );
      const part = toolPartOf(state, 'msg-1', 'tc-1');
      expect(part?.state).toBe('output-error');
      if (part?.state !== 'output-error') throw new Error('expected output-error');
      expect(part.errorText).toBe('bad input');
      expect(part.input).toEqual({ q: 'x' });
    });

    it('creates an orphan part on tool-input-error with no prior start', () => {
      let state = init();
      state = fold(
        state,
        { type: 'tool-input-error', toolCallId: 'tc-1', toolName: 'search', input: { q: 'x' }, errorText: 'boom' },
        meta('s1', 'msg-1'),
      );
      const part = toolPartOf(state, 'msg-1', 'tc-1');
      expect(part?.state).toBe('output-error');
      if (part?.state !== 'output-error') throw new Error('expected output-error');
      expect(part.errorText).toBe('boom');
    });
  });

  // -- lifecycle folds (finish-step reset, metadata merges) -----------------

  describe('lifecycle folds', () => {
    it('finish-step resets text/reasoning trackers so a follow-up step reuses stream ids cleanly', () => {
      let state = init();
      state = fold(state, { type: 'start' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'text-start', id: 't1' }, meta('s2', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't1', delta: 'step-one' }, meta('s3', 'msg-1'));
      // The in-progress stream is tracked before the step boundary.
      expect(state.trackers.get('msg-1')?.text.size).toBe(1);

      state = fold(state, { type: 'finish-step' }, meta('s4', 'msg-1'));
      // The step boundary clears the text/reasoning trackers.
      expect(state.trackers.get('msg-1')?.text.size).toBe(0);

      // A follow-up step reuses stream id 't1'; the cleared tracker means it
      // opens a fresh part rather than mis-correlating onto the first.
      state = fold(state, { type: 'text-start', id: 't1' }, meta('s5', 'msg-1'));
      state = fold(state, { type: 'text-delta', id: 't1', delta: 'step-two' }, meta('s6', 'msg-1'));

      const texts = msgById(state, 'msg-1')
        ?.parts.filter((p): p is AI.TextUIPart => p.type === 'text')
        .map((p) => p.text);
      expect(texts).toEqual(['step-one', 'step-two']);
    });

    it('sets messageMetadata from a finish chunk onto the message', () => {
      let state = init();
      state = fold(state, { type: 'start' }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'finish', messageMetadata: { tokens: 42 } }, meta('s2', 'msg-1'));
      expect(msgById(state, 'msg-1')?.metadata).toEqual({ tokens: 42 });
    });

    it('overwrites metadata from a message-metadata chunk on the message', () => {
      let state = init();
      state = fold(state, { type: 'start', messageMetadata: { a: 1 } }, meta('s1', 'msg-1'));
      state = fold(state, { type: 'message-metadata', messageMetadata: { b: 2 } }, meta('s2', 'msg-1'));
      expect(msgById(state, 'msg-1')?.metadata).toEqual({ b: 2 });
    });

    it('ignores a message-metadata chunk for an unknown message and creates none', () => {
      let state = init();
      state = fold(state, { type: 'message-metadata', messageMetadata: { b: 2 } }, meta('s1', 'msg-1'));
      expect(state.messages).toHaveLength(0);
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

      state = UIMessageCodec.fold(state, { direction: 'input', event }, meta('s1', 'cm-1'));
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
