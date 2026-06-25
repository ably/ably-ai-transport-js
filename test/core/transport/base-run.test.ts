/**
 * Unit tests for `createBaseRun` — the shared run read-model over the Tree.
 *
 * Exercises the four read members (`runId`, `status`, `error`, `messages`)
 * against a minimal in-memory Tree, covering the whole-turn composition
 * (input + this run's output), the fresh / continuation / no-input / wire-only
 * cases, dedupe, terminal status/error, liveness, and the union invariant.
 */

import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { Codec, Regenerate, UserMessage } from '../../../src/core/codec/types.js';
import { createBaseRun } from '../../../src/core/transport/base-run.js';
import type { ConversationNode, InputNode, RunNode, RunNodeState, Tree } from '../../../src/core/transport/types.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

type TestInput = UserMessage<TestMessage> | Regenerate;
interface TestOutput {
  type: string;
}
interface TestMessage {
  id: string;
  content: string;
}
interface TestProjection {
  messages: TestMessage[];
}

// A codec stub: createBaseRun only ever calls getMessages, but the full Codec
// surface is provided so no cast is needed. The unused members throw if called.
const unused = (): never => {
  throw new Error('not used in these tests');
};
const codec: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
  init: () => ({ messages: [] }),
  fold: (state) => state,
  getMessages: (p) => p.messages.map((m) => ({ codecMessageId: m.id, message: m })),
  createUserMessage: unused,
  createRegenerate: unused,
  createEncoder: unused,
  createDecoder: unused,
};

// ---------------------------------------------------------------------------
// Minimal Tree
// ---------------------------------------------------------------------------

const projectionOf = (...ids: string[]): TestProjection => ({
  messages: ids.map((id) => ({ id, content: id })),
});

const inputNode = (codecMessageId: string, projection: TestProjection): InputNode<TestProjection> => ({
  kind: 'input',
  codecMessageId,
  parentCodecMessageId: undefined,
  forkOf: undefined,
  projection,
  serial: undefined,
});

const runNode = (
  runId: string,
  projection: TestProjection,
  state?: RunNodeState,
  parentCodecMessageId?: string,
): RunNode<TestProjection> => ({
  kind: 'run',
  runId,
  parentCodecMessageId,
  forkOf: undefined,
  regeneratesCodecMessageId: undefined,
  clientId: '',
  state: state ?? { status: 'active' },
  projection,
  invocationId: '',
  startSerial: undefined,
  endSerial: undefined,
  steps: [],
});

// A run getter for runs with no triggering input node — output-only turns.
const noAnchor = vi.fn((): string | undefined => undefined);

// Build a Tree mock from input nodes (keyed by codec-message-id) and run nodes
// (keyed by run-id). createBaseRun only reads getRunNode / getNodeByCodecMessageId;
// the rest are inert stubs.
const makeTree = (
  inputs: InputNode<TestProjection>[],
  runs: RunNode<TestProjection>[],
): Tree<TestOutput, TestProjection> => {
  const byCodecMessageId = new Map<string, ConversationNode<TestProjection>>(inputs.map((n) => [n.codecMessageId, n]));
  const byRunId = new Map<string, RunNode<TestProjection>>(runs.map((n) => [n.runId, n]));
  return {
    getRunNode: (runId) => byRunId.get(runId),
    getNodeByCodecMessageId: (id) => byCodecMessageId.get(id),
    getSiblingNodes: () => [],
    findAblyMessageByEventId: vi.fn(),
    on: () => vi.fn(),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBaseRun', () => {
  it('reads an unknown run as active with no error and no messages', () => {
    const tree = makeTree([], []);
    const run = createBaseRun({ getRunId: () => '', getInputAnchor: noAnchor, getTree: () => tree, codec });
    expect(run.runId).toBe('');
    expect(run.status).toBe('active');
    expect(run.error).toBeUndefined();
    expect(run.messages).toEqual([]);
  });

  it('composes the whole turn for a fresh send: input message then this run output', () => {
    const tree = makeTree(
      [inputNode('u1', projectionOf('u1'))],
      [runNode('r1', projectionOf('a1'), { status: 'active' }, 'u1')],
    );
    const run = createBaseRun({ getRunId: () => 'r1', getInputAnchor: () => 'u1', getTree: () => tree, codec });
    expect(run.messages).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
    ]);
  });

  it('returns output only for a no-input run (no anchor)', () => {
    const tree = makeTree([], [runNode('r1', projectionOf('a1'))]);
    const run = createBaseRun({ getRunId: () => 'r1', getInputAnchor: noAnchor, getTree: () => tree, codec });
    expect(run.messages).toEqual([{ id: 'a1', content: 'a1' }]);
  });

  it('returns output only when the anchor resolves to a non-input (wire-only carrier)', () => {
    // A regenerate/tool carrier's anchor points at a prior run node, not an
    // input node — it introduced no input message, so the turn is output-only.
    const prior = runNode('prior', projectionOf('a-prior'));
    const tree = makeTree([], [prior, runNode('r1', projectionOf('a1'))]);
    const byCodecMessageId = new Map<string, ConversationNode<TestProjection>>([['prior', prior]]);
    const treeWithRunByCmid: Tree<TestOutput, TestProjection> = {
      ...tree,
      getNodeByCodecMessageId: (id) => byCodecMessageId.get(id),
    };
    const run = createBaseRun({
      getRunId: () => 'r1',
      getInputAnchor: () => 'prior',
      getTree: () => treeWithRunByCmid,
      codec,
    });
    expect(run.messages).toEqual([{ id: 'a1', content: 'a1' }]);
  });

  it('dedupes by codec-message-id across input and run projections', () => {
    // A continuation whose input node shares a message id with its run node
    // must not double-count it.
    const tree = makeTree(
      [inputNode('shared', projectionOf('shared'))],
      [runNode('r1', projectionOf('shared', 'a1'), { status: 'active' }, 'shared')],
    );
    const run = createBaseRun({ getRunId: () => 'r1', getInputAnchor: () => 'shared', getTree: () => tree, codec });
    expect(run.messages).toEqual([
      { id: 'shared', content: 'shared' },
      { id: 'a1', content: 'a1' },
    ]);
  });

  it('surfaces a terminal error status and detail', () => {
    const error = new Ably.ErrorInfo('boom', 50000, 500);
    const tree = makeTree([], [runNode('r1', projectionOf('a1'), { status: 'error', error })]);
    const run = createBaseRun({ getRunId: () => 'r1', getInputAnchor: noAnchor, getTree: () => tree, codec });
    expect(run.status).toBe('error');
    expect(run.error).toBe(error);
  });

  it('reflects suspended and complete status with no error', () => {
    const suspended = makeTree([], [runNode('r1', projectionOf(), { status: 'suspended' })]);
    const complete = makeTree([], [runNode('r2', projectionOf(), { status: 'complete' })]);
    expect(
      createBaseRun({ getRunId: () => 'r1', getInputAnchor: noAnchor, getTree: () => suspended, codec }).status,
    ).toBe('suspended');
    const completeRun = createBaseRun({
      getRunId: () => 'r2',
      getInputAnchor: noAnchor,
      getTree: () => complete,
      codec,
    });
    expect(completeRun.status).toBe('complete');
    expect(completeRun.error).toBeUndefined();
  });

  it('returns a fresh array each access — mutation does not bleed', () => {
    const tree = makeTree(
      [inputNode('u1', projectionOf('u1'))],
      [runNode('r1', projectionOf('a1'), { status: 'active' }, 'u1')],
    );
    const run = createBaseRun({ getRunId: () => 'r1', getInputAnchor: () => 'u1', getTree: () => tree, codec });
    run.messages.push({ id: 'leak', content: 'no' });
    expect(run.messages).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
    ]);
  });

  it('reads live — status and messages advance as the run node changes', () => {
    const node = runNode('r1', projectionOf('a1'), { status: 'active' }, 'u1');
    const input = inputNode('u1', projectionOf('u1'));
    const tree = makeTree([input], [node]);
    const run = createBaseRun({ getRunId: () => 'r1', getInputAnchor: () => 'u1', getTree: () => tree, codec });
    expect(run.status).toBe('active');
    expect(run.messages).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
    ]);

    node.projection = projectionOf('a1', 'a2');
    node.state = { status: 'complete' };
    expect(run.status).toBe('complete');
    expect(run.messages).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'a2', content: 'a2' },
    ]);
  });

  it("reconstructs the conversation from the union of each run's whole turn", () => {
    const tree = makeTree(
      [inputNode('u1', projectionOf('u1')), inputNode('u2', projectionOf('u2'))],
      [
        runNode('r1', projectionOf('a1'), { status: 'complete' }, 'u1'),
        runNode('r2', projectionOf('a2'), { status: 'complete' }, 'u2'),
      ],
    );
    const r1 = createBaseRun({ getRunId: () => 'r1', getInputAnchor: () => 'u1', getTree: () => tree, codec });
    const r2 = createBaseRun({ getRunId: () => 'r2', getInputAnchor: () => 'u2', getTree: () => tree, codec });
    expect([...r1.messages, ...r2.messages]).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2', content: 'u2' },
      { id: 'a2', content: 'a2' },
    ]);
  });
});
