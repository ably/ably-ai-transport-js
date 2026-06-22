/**
 * Transport-level sequencing of the Vercel codec.
 *
 * The Vercel reducer no longer dedups or orders — the conflict-key gate is
 * gone (4c). Correctness now comes from the Tree, which sequences a node's
 * wires canonically (ascending by serial, refolding when a wire lands out of
 * position) and drops whole-wire replays via its per-entry version
 * high-water-mark. These tests drive the real UIMessageCodec through a Tree to
 * prove the old gate's guarantees still hold from that composition:
 *
 *  - last-writer-wins for competing tool outputs, regardless of arrival order
 *    (the gate's headline behaviour, now a property of the refold); and
 *  - a duplicate-free projection when a wire is re-delivered (history replay /
 *    remount), which the gate used to cover for keyed events and now the
 *    transport covers for every wire.
 *
 * The in-wire "two same-key events both fold" case is a reducer property and
 * lives in reducer.test.ts.
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_INPUT_EVENT_ID,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_STREAM,
} from '../../../src/constants.js';
import { createTree } from '../../../src/core/transport/tree.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import type { VercelProjection } from '../../../src/vercel/codec/reducer.js';

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

const RUN_ID = 'R1';
const ASSISTANT = 'a1';

// Apply one agent-output wire (a run message) to the Tree.
const applyOutput = (
  tree: ReturnType<typeof createTree<VercelInput, VercelOutput, VercelProjection>>,
  outputs: VercelOutput[],
  serial: string,
  version: string,
  streamed = true,
): void => {
  const headers: Record<string, string> = { [HEADER_RUN_ID]: RUN_ID, [HEADER_CODEC_MESSAGE_ID]: ASSISTANT };
  if (streamed) headers[HEADER_STREAM] = 'true';
  tree.applyMessage({ inputs: [], outputs }, headers, serial, undefined, version);
};

// Apply one client-input wire targeting the run (a continuation amending the
// run's assistant). Routed to the run node by run-id; the tool resolution
// finds its assistant by the codec-message-id in the event payload.
const applyInput = (
  tree: ReturnType<typeof createTree<VercelInput, VercelOutput, VercelProjection>>,
  inputs: VercelInput[],
  serial: string,
  version: string,
): void => {
  const headers: Record<string, string> = { [HEADER_RUN_ID]: RUN_ID, [HEADER_CODEC_MESSAGE_ID]: ASSISTANT };
  tree.applyMessage({ inputs, outputs: [] }, headers, serial, undefined, version);
};

const USER = 'u1';

// Apply one run-less user-input wire (an input node keyed by codec-message-id).
// Serial-less is an optimistic seed; a serial promotes it.
const applyUserInput = (
  tree: ReturnType<typeof createTree<VercelInput, VercelOutput, VercelProjection>>,
  inputs: VercelInput[],
  serial?: string,
  version?: string,
): void => {
  const headers: Record<string, string> = { [HEADER_ROLE]: 'user', [HEADER_CODEC_MESSAGE_ID]: USER };
  tree.applyMessage({ inputs, outputs: [] }, headers, serial, undefined, version);
};

// The reconstructed user message on the input node, if any.
const userMessage = (
  tree: ReturnType<typeof createTree<VercelInput, VercelOutput, VercelProjection>>,
): AI.UIMessage | undefined => {
  const node = tree.getNodeByCodecMessageId(USER);
  return node ? UIMessageCodec.getMessages(node.projection)[0]?.message : undefined;
};

// The dynamic-tool part for `toolCallId` on the run's assistant, if any.
const toolPart = (
  tree: ReturnType<typeof createTree<VercelInput, VercelOutput, VercelProjection>>,
  toolCallId: string,
): AI.DynamicToolUIPart | undefined => {
  const run = tree.getRunNode(RUN_ID);
  if (run === undefined) return undefined;
  const message = UIMessageCodec.getMessages(run.projection)[0]?.message;
  return message?.parts.find(
    (p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool' && p.toolCallId === toolCallId,
  );
};

const toolInputStart: VercelOutput = { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'echo', dynamic: true };
const toolInputAvailable: VercelOutput = {
  type: 'tool-input-available',
  toolCallId: 'tc-1',
  toolName: 'echo',
  input: {},
  dynamic: true,
};
const toolOutput = (v: string): VercelOutput => ({
  type: 'tool-output-available',
  toolCallId: 'tc-1',
  output: { v },
  dynamic: true,
});

/**
 * Text of the first text part in a message, if any.
 * @param m - The message to read.
 * @returns The text, or undefined.
 */
const textOf = (m: AI.UIMessage | undefined): string | undefined =>
  m?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;

/**
 * The resolved output of the first dynamic-tool part in a message, if resolved.
 * @param m - The message to read.
 * @returns The tool output, or undefined when no resolved tool part is present.
 */
const outputOf = (m: AI.UIMessage | undefined): unknown => {
  const part = m?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
  return part?.state === 'output-available' ? part.output : undefined;
};

describe('Vercel codec over the Tree', () => {
  it('resolves competing tool outputs by serial — the highest-serial write wins regardless of arrival order', () => {
    const tree = createTree<VercelInput, VercelOutput, VercelProjection>(UIMessageCodec, silentLogger);

    // Seed the tool call (input-available) over two wires.
    applyOutput(tree, [toolInputStart], 's1', 's1');
    applyOutput(tree, [toolInputAvailable], 's2', 's2');

    // The higher-serial output arrives first and folds onto the tail.
    applyOutput(tree, [toolOutput('higher')], 's4', 's4');
    // The lower-serial output arrives late (cross-publisher reorder). It lands
    // before s4 in the log, so the Tree refolds the node from scratch in serial
    // order — s1, s2, s3, s4 — and the highest serial (s4) wins.
    applyOutput(tree, [toolOutput('lower')], 's3', 's3');

    const part = toolPart(tree, 'tc-1');
    expect(part?.state === 'output-available' && part.output).toEqual({ v: 'higher' });
  });

  it('resolves a client tool-result against an agent transition by serial — the client result (highest serial) wins', () => {
    // The cross-direction case the deleted gate shared one `tool-output:` key
    // for: a client-published tool-result (input) and an agent-published
    // tool-output-available (output) compete for the same tool part. The
    // client result is published causally later, so it carries the higher
    // serial and must win.
    const tree = createTree<VercelInput, VercelOutput, VercelProjection>(UIMessageCodec, silentLogger);

    applyOutput(tree, [toolInputStart], 's1', 's1');
    applyOutput(tree, [toolInputAvailable], 's2', 's2');

    // The client result folds first onto the tail.
    const clientResult: VercelInput = {
      kind: 'tool-result',
      codecMessageId: ASSISTANT,
      payload: { toolCallId: 'tc-1', output: { v: 'client' } },
    };
    applyInput(tree, [clientResult], 's4', 's4');
    // The agent's transition arrives late with a lower serial — a non-tail
    // insert triggers a refold, replaying s1..s4 in order so the client result
    // (s4) folds last and wins over the agent output (s3).
    applyOutput(tree, [toolOutput('agent')], 's3', 's3');

    const part = toolPart(tree, 'tc-1');
    expect(part?.state === 'output-available' && part.output).toEqual({ v: 'client' });
  });

  it('drops a whole-wire replay so the projection is not duplicated', () => {
    const tree = createTree<VercelInput, VercelOutput, VercelProjection>(UIMessageCodec, silentLogger);

    const textWire: VercelOutput[] = [
      { type: 'text-start', id: 't-1' },
      { type: 'text-delta', id: 't-1', delta: 'hello' },
    ];

    // First delivery folds the text.
    applyOutput(tree, textWire, 's1', 's1@1');
    // History replay / remount re-delivers the identical wire (same serial and
    // version). The Tree's decodedThrough guard drops it before the reducer,
    // so the text is not appended twice.
    applyOutput(tree, textWire, 's1', 's1@1');

    const run = tree.getRunNode(RUN_ID);
    const message = run ? UIMessageCodec.getMessages(run.projection)[0]?.message : undefined;
    const text = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(text?.text).toBe('hello');
  });

  it('reconciles an optimistic user-message seed with its per-part echo — no duplicated parts', () => {
    // The client seeds the full message optimistically with no serial; the echo
    // re-delivers it part by part, each part its own serial-bearing wire (the
    // batch encoder gives every part a distinct serial). The first echo wire
    // promotes the node and refolds from the log alone, discarding the seed;
    // later parts merge incrementally — no duplication, no reducer-side seed logic.
    const tree = createTree<VercelInput, VercelOutput, VercelProjection>(UIMessageCodec, silentLogger);

    const seeded: AI.UIMessage = {
      id: 'u-1',
      role: 'user',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' },
      ],
    };
    applyUserInput(tree, [{ kind: 'user-message', message: seeded }]);
    expect(userMessage(tree)?.parts).toHaveLength(2); // seed visible pre-echo

    const echoText: VercelInput = {
      kind: 'user-message',
      message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    };
    const echoFile: VercelInput = {
      kind: 'user-message',
      message: { id: 'u-1', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: 'https://x/y.png' }] },
    };
    // First echo part (its own serial) promotes the node and refolds from the
    // log, discarding the seed — only the text part remains.
    applyUserInput(tree, [echoText], 's1', 's1');
    expect(userMessage(tree)?.parts).toEqual([{ type: 'text', text: 'hello' }]);

    // Second echo part (higher serial) is a tail append, merged incrementally.
    applyUserInput(tree, [echoFile], 's2', 's2');
    expect(userMessage(tree)?.parts).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' },
    ]);
  });

  it('isolates two tabs continuing one run into separate continuations (AIT-843)', () => {
    const tree = createTree<VercelInput, VercelOutput, VercelProjection>(UIMessageCodec, silentLogger);

    // Seed the suspended assistant cm_tc with an unresolved client tool call.
    applyOutput(tree, [toolInputStart], 's01', 's01');
    applyOutput(tree, [toolInputAvailable], 's02', 's02');

    // Two tabs each publish a tool-result for cm_tc, with DISTINCT wire event-ids.
    const resultInput = (v: string): VercelInput => ({
      kind: 'tool-result',
      codecMessageId: ASSISTANT,
      payload: { toolCallId: 'tc-1', output: { v } },
    });
    tree.applyMessage(
      { inputs: [resultInput('A')], outputs: [] },
      { [HEADER_RUN_ID]: RUN_ID, [HEADER_CODEC_MESSAGE_ID]: ASSISTANT, [HEADER_EVENT_ID]: 'EA' },
      's03',
      undefined,
      's03',
    );
    tree.applyMessage(
      { inputs: [resultInput('B')], outputs: [] },
      { [HEADER_RUN_ID]: RUN_ID, [HEADER_CODEC_MESSAGE_ID]: ASSISTANT, [HEADER_EVENT_ID]: 'EB' },
      's04',
      undefined,
      's04',
    );

    // Each tab's agent streams a follow-up under its own codec-message-id,
    // echoing its triggering input's event-id as `input-event-id`.
    const followup = (cmId: string, eventId: string, text: string, base: string): void => {
      const headers = {
        [HEADER_RUN_ID]: RUN_ID,
        [HEADER_CODEC_MESSAGE_ID]: cmId,
        [HEADER_INPUT_EVENT_ID]: eventId,
        [HEADER_STREAM]: 'true',
      };
      tree.applyMessage(
        { inputs: [], outputs: [{ type: 'start', messageId: cmId }] },
        headers,
        `${base}1`,
        undefined,
        `${base}1`,
      );
      tree.applyMessage(
        { inputs: [], outputs: [{ type: 'text-start', id: `${eventId}t` }] },
        headers,
        `${base}2`,
        undefined,
        `${base}2`,
      );
      tree.applyMessage(
        { inputs: [], outputs: [{ type: 'text-delta', id: `${eventId}t`, delta: text }] },
        headers,
        `${base}3`,
        undefined,
        `${base}3`,
      );
    };
    followup('cm_fuA', 'EA', 'You are in A', 's05');
    followup('cm_fuB', 'EB', 'You are in B', 's06');

    const run = tree.getRunNode(RUN_ID);
    expect(run).toBeDefined();
    if (!run) return;

    // Canonical pick (no selector) → earliest continuation by serial → tab A.
    const canonical = UIMessageCodec.getMessages(run.projection);
    expect(canonical.map((m) => m.codecMessageId)).toEqual([ASSISTANT, 'cm_fuA']);
    expect(outputOf(canonical[0]?.message)).toEqual({ v: 'A' });
    expect(textOf(canonical[1]?.message)).toBe('You are in A');

    // Selector → tab B's continuation; its follow-up never leaks into A's.
    const scopedToB = UIMessageCodec.getMessages(run.projection, { continuationEventId: 'EB' });
    expect(scopedToB.map((m) => m.codecMessageId)).toEqual([ASSISTANT, 'cm_fuB']);
    expect(outputOf(scopedToB[0]?.message)).toEqual({ v: 'B' });
    expect(textOf(scopedToB[1]?.message)).toBe('You are in B');
  });
});
