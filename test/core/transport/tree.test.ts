import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_START_SERIAL,
  HEADER_STEP_ID,
  HEADER_STREAM,
} from '../../../src/constants.js';
import type { Codec, CodecEvent, CodecInputEvent, Regenerate, UserMessage } from '../../../src/core/codec/types.js';
import type { TreeInternal } from '../../../src/core/transport/tree.js';
import { createTree, REORDER_WINDOW_MS } from '../../../src/core/transport/tree.js';
import type {
  ConversationNode,
  InputNode,
  OutputEvent,
  RunNode,
  StepEndReason,
} from '../../../src/core/transport/types.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Test codec — minimal projection that appends messages on fold
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

type TestInput =
  | ({ kind: 'append-input'; message: TestMessage } & CodecInputEvent)
  | UserMessage<TestMessage>
  | Regenerate;

type TestOutput = { type: 'append-message'; message: TestMessage } | { type: 'noop' } | { type: 'throw' };

interface TestProjection {
  messages: TestMessage[];
}

const testCodec: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
  init: () => ({ messages: [] }),
  fold: (state: TestProjection, codecEvent: CodecEvent<TestInput, TestOutput>) => {
    const event = codecEvent.event;
    if ('type' in event) {
      if (event.type === 'append-message') {
        return { messages: [...state.messages, event.message] };
      }
      if (event.type === 'throw') {
        throw new Error('test fold failure');
      }
      return state;
    }
    // Inputs: `append-input` / `user-message` carry a message; `regenerate`
    // is a wire-only signal with nothing to fold.
    if (event.kind === 'regenerate') return state;
    return { messages: [...state.messages, event.message] };
  },
  getMessages: (projection: TestProjection) => projection.messages.map((m) => ({ codecMessageId: m.id, message: m })),
  createEncoder: () => {
    throw new Error('not used in tree tests');
  },
  createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
  createUserMessage: (message: TestMessage) => ({ kind: 'user-message', message }),
  createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate', target, parent }),
};

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

/** Empty selections — always picks the latest sibling at every fork. */
const NO_SELECTIONS = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApplyOpts {
  runId: string;
  codecMessageId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  role?: string;
  invocationId?: string;
  clientId?: string;
  inputCodecMessageId?: string;
  serial?: string;
  timestamp?: number;
  /** The delivery's `Message.version.serial` (drives the per-entry replay guard). */
  version?: string;
  /** Sets the `stream` transport header so the wire folds as a streamed wire. */
  streamed?: boolean;
  /** Sets the `step-id` transport header (step-attributed output). */
  stepId?: string;
  /** Sets the `start-serial` transport header (the back-ref to the owning step attempt's `ai-step-start` serial). */
  startSerial?: string;
  message?: TestMessage;
  /** Override events entirely. When set, `message` is ignored. */
  events?: (TestInput | TestOutput)[];
}

type TreeEvent = TestInput | TestOutput;

const apply = (tree: TreeInternal<TestInput, TestOutput, TestProjection>, opts: ApplyOpts): void => {
  const h: Record<string, string> = { [HEADER_RUN_ID]: opts.runId };
  if (opts.codecMessageId) h[HEADER_CODEC_MESSAGE_ID] = opts.codecMessageId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h['msg-regenerate'] = opts.regenerates;
  if (opts.role) h[HEADER_ROLE] = opts.role;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.clientId) h[HEADER_RUN_CLIENT_ID] = opts.clientId;
  if (opts.inputCodecMessageId) h[HEADER_INPUT_CODEC_MESSAGE_ID] = opts.inputCodecMessageId;
  if (opts.streamed) h[HEADER_STREAM] = 'true';
  if (opts.stepId !== undefined) h[HEADER_STEP_ID] = opts.stepId;
  if (opts.startSerial !== undefined) h[HEADER_START_SERIAL] = opts.startSerial;

  const events: TreeEvent[] = opts.events ?? (opts.message ? [{ type: 'append-message', message: opts.message }] : []);
  const inputs = events.filter((e): e is TestInput => 'kind' in e);
  const outputs = events.filter((e): e is TestOutput => 'type' in e);
  tree.applyMessage({ inputs, outputs }, h, opts.serial, opts.timestamp, opts.version);
};

const messagesOf = (tree: TreeInternal<TestInput, TestOutput, TestProjection>, runId: string): TestMessage[] => {
  const run = tree.getRunNode(runId);
  return run ? testCodec.getMessages(run.projection).map((cm) => cm.message) : [];
};

// The message ids materialised for a run (step-precedence assertions).
const idsOf = (tree: TreeInternal<TestInput, TestOutput, TestProjection>, runId: string): string[] =>
  messagesOf(tree, runId).map((m) => m.id);

const inputMessagesOf = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  codecMessageId: string,
): TestMessage[] => {
  const node = tree.getNodeByCodecMessageId(codecMessageId);
  return node ? testCodec.getMessages(node.projection).map((cm) => cm.message) : [];
};

// Apply a run-LESS user input wire (an input node keyed by its codec-message-id).
const applyInput = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  opts: {
    codecMessageId: string;
    parent?: string;
    forkOf?: string;
    message: TestMessage;
    serial?: string;
    timestamp?: number;
  },
): void => {
  const h: Record<string, string> = { [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId, [HEADER_ROLE]: 'user' };
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  tree.applyMessage(
    { inputs: [{ kind: 'append-input', message: opts.message }], outputs: [] },
    h,
    opts.serial,
    opts.timestamp,
  );
};

// Apply a run-start or run-end lifecycle event with a timestamp (retention tests).
const lifecycle = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  type: 'start' | 'end',
  runId: string,
  serial: string | undefined,
  timestamp: number | undefined,
): void => {
  if (type === 'start') {
    tree.applyRunLifecycle({ type: 'start', runId, clientId: 'c1', invocationId: '', serial, timestamp });
  } else {
    tree.applyRunLifecycle({
      type: 'end',
      runId,
      clientId: 'c1',
      invocationId: '',
      serial,
      timestamp,
      reason: 'complete',
    });
  }
};

// Apply a step-lifecycle event (step-start / step-end). The invocation + client
// scopes default to empty strings (the common stepless-history shape); a test
// asserting stepClientId surfacing supplies it via `opts.stepClientId`.
//
// An attempt's identity is the serial of its `ai-step-start`. A step-start's
// `serial` IS that identity; a step-end carries it back as `startSerial` (which
// defaults to the step-end's own `serial` for the common in-order case where a
// caller does not need to express a distinct back-ref).
const applyStep = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  opts: {
    type: 'step-start' | 'step-end';
    runId: string;
    stepId: string;
    serial?: string;
    /** The step-end's `start-serial` back-ref; defaults to `serial`. Ignored for step-start. */
    startSerial?: string;
    timestamp?: number;
    reason?: StepEndReason;
    invocationId?: string;
    runClientId?: string;
    invocationClientId?: string;
    stepClientId?: string;
  },
): void => {
  const stamped = opts.timestamp === undefined ? {} : { timestamp: opts.timestamp };
  const scopes = {
    invocationId: opts.invocationId ?? '',
    runClientId: opts.runClientId ?? '',
    invocationClientId: opts.invocationClientId ?? '',
    stepClientId: opts.stepClientId ?? '',
  };
  if (opts.type === 'step-start') {
    tree.applyStepLifecycle({
      type: 'step-start',
      runId: opts.runId,
      stepId: opts.stepId,
      ...scopes,
      serial: opts.serial,
      ...stamped,
    });
  } else {
    tree.applyStepLifecycle({
      type: 'step-end',
      runId: opts.runId,
      stepId: opts.stepId,
      startSerial: opts.startSerial ?? opts.serial ?? '',
      ...scopes,
      serial: opts.serial,
      reason: opts.reason ?? 'complete',
      ...stamped,
    });
  }
};

// Build a Tree with an explicit `reorderWindowMs`, pushing every warn-level log
// into the given collector so a degraded arrival-order fold / swept-supersede is
// observable. Used by the injection-seam and sweep-gate retention tests.
const treeWithWindow = (
  reorderWindowMs: number,
  warns: string[],
): TreeInternal<TestInput, TestOutput, TestProjection> =>
  createTree<TestInput, TestOutput, TestProjection>(
    testCodec,
    makeLogger({
      logLevel: LogLevel.Warn,
      logHandler: (message, level) => {
        if (level === LogLevel.Warn) warns.push(message);
      },
    }),
    reorderWindowMs,
  );

// The visible node keys (runId for runs, codec-message-id for inputs), in order.
const visibleKeys = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): string[] => tree.visibleNodes(selections).map((n) => (n.kind === 'run' ? n.runId : n.codecMessageId));

// The visible reply runs along the selected branches (input nodes filtered out).
const replyRuns = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): RunNode<TestProjection>[] =>
  tree.visibleNodes(selections).filter((n): n is RunNode<TestProjection> => n.kind === 'run');

const flatMessages = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): TestMessage[] =>
  replyRuns(tree, selections).flatMap((r) => testCodec.getMessages(r.projection).map((cm) => cm.message));

const flatRunIds = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): string[] => replyRuns(tree, selections).map((r) => r.runId);

// The visible reply runs that are siblings of the node keyed by `key`.
const siblingRuns = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  key: string,
): RunNode<TestProjection>[] => tree.getSiblingNodes(key).filter((n): n is RunNode<TestProjection> => n.kind === 'run');

// Narrow a node union to its runId, or undefined for a non-run / absent node.
const runIdOf = (node: ConversationNode<TestProjection> | undefined): string | undefined =>
  node?.kind === 'run' ? node.runId : undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tree', () => {
  let tree: TreeInternal<TestInput, TestOutput, TestProjection>;

  beforeEach(() => {
    tree = createTree<TestInput, TestOutput, TestProjection>(testCodec, silentLogger);
  });

  // -------------------------------------------------------------------------
  // Linear conversation
  // -------------------------------------------------------------------------

  describe('linear conversation', () => {
    it('creates a single Run from one message', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(flatRunIds(tree)).toEqual(['R1']);
      expect(flatMessages(tree)).toEqual([{ id: 'a', content: 'hi' }]);
    });

    it('creates a chain of Runs in startSerial order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'third' },
        serial: 's3',
      });

      expect(flatRunIds(tree)).toEqual(['R1', 'R2', 'R3']);
      expect(flatMessages(tree)).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });

    it('records the structural parentCodecMessageId from the parent header', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'a' },
        serial: 's2',
      });
      // Reachability keys on the structural parent codec-message-id.
      expect(tree.getRunNode('R2')?.parentCodecMessageId).toBe('m1');
    });

    it('returns RunNode via getRunNode', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const run = tree.getRunNode('R1');
      expect(run).toBeDefined();
      expect(run?.kind).toBe('run');
      expect(run?.runId).toBe('R1');
      const projection = run?.projection;
      if (!projection) throw new Error('expected projection');
      expect(testCodec.getMessages(projection)).toEqual([{ codecMessageId: 'a', message: { id: 'a', content: 'hi' } }]);
    });

    it('returns undefined for an unknown runId', () => {
      expect(tree.getRunNode('R-unknown')).toBeUndefined();
    });

    it('narrows a ConversationNode union on its kind discriminator', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const run = tree.getRunNode('R1');
      if (!run) throw new Error('expected run');

      const input: InputNode<TestProjection> = {
        kind: 'input',
        codecMessageId: 'm1',
        parentCodecMessageId: undefined,
        forkOf: undefined,
        projection: { messages: [{ id: 'u', content: 'prompt' }] },
        serial: 's0',
      };

      // The union narrows on `kind`; each arm exposes only its own key.
      const keyOf = (node: ConversationNode<TestProjection>): string =>
        node.kind === 'run' ? node.runId : node.codecMessageId;

      expect(keyOf(run)).toBe('R1');
      expect(keyOf(input)).toBe('m1');
    });

    it('returns owning node via getNodeByCodecMessageId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      expect(tree.getNodeByCodecMessageId('m-unknown')).toBeUndefined();
    });

    it('returns a node by node-key via getNode (runId or input codec-message-id)', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u', content: 'prompt' }, serial: 's0' });

      // A reply run keys on its runId; an input node keys on its codec-message-id.
      expect(runIdOf(tree.getNode('R1'))).toBe('R1');
      expect(tree.getNode('u1')?.kind).toBe('input');
      expect(tree.getNode('unknown')).toBeUndefined();
    });

    it('getNode keys strictly on node-key, unlike getNodeByCodecMessageId', () => {
      // 'm1' is the run's owned assistant codec-message-id, not its node key.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      // getNodeByCodecMessageId resolves the owned cmid to the run; getNode does not.
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      expect(tree.getNode('m1')).toBeUndefined();
    });

    it('drops messages without an run-id header', () => {
      tree.applyMessage(
        { inputs: [], outputs: [{ type: 'append-message', message: { id: 'a', content: 'orphan' } }] },
        {},
        's1',
      );
      expect(replyRuns(tree, NO_SELECTIONS)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // applyMessage updates
  // -------------------------------------------------------------------------

  describe('applyMessage updates', () => {
    it('folds additional events into an existing Run projection', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
      ]);
    });

    it('routes events to the owning Run by codecMessageId (continuation amend)', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      // Continuation message stamped under R1 with prior codec-message-id; folds into R1's projection.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        message: { id: 'a', content: 'amended' },
        serial: 's2',
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'a', content: 'amended' },
      ]);
    });

    it('isolates a throwing fold per event without aborting the batch or apply', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'ok' }, serial: 's1' });
      // A throwing event mid-batch must neither crash applyMessage nor skip the
      // events folded after it — each fold is isolated.
      expect(() => {
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'm1',
          events: [
            { type: 'append-message', message: { id: 'b', content: 'before' } },
            { type: 'throw' },
            { type: 'append-message', message: { id: 'c', content: 'after' } },
          ],
          serial: 's2',
        });
      }).not.toThrow();
      // The earlier message and both sides of the throwing event survive.
      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'ok' },
        { id: 'b', content: 'before' },
        { id: 'c', content: 'after' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Canonical fold order (refold on out-of-order arrival)
  // -------------------------------------------------------------------------

  describe('canonical fold order', () => {
    it('folds a late, earlier-serial wire into its canonical position', () => {
      // The higher serial arrives first, then a genuinely new lower-serial wire
      // (cross-publisher reorder). The node must end folded in serial order,
      // not arrival order.
      apply(tree, { runId: 'R1', codecMessageId: 'm2', message: { id: 'b', content: 'second' }, serial: 's2' });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
      ]);
    });

    it('leaves in-order delivery untouched (no refold)', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm2', message: { id: 'b', content: 'second' }, serial: 's2' });
      apply(tree, { runId: 'R1', codecMessageId: 'm3', message: { id: 'c', content: 'third' }, serial: 's3' });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });

    it('reorders three wires delivered fully out of order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm3', message: { id: 'c', content: 'third' }, serial: 's3' });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm2', message: { id: 'b', content: 'second' }, serial: 's2' });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });

    it('refolds an input node when its parts arrive out of order', () => {
      // A multi-message input node whose later-serial wire lands before the
      // earlier one — the refold path also covers run-less input nodes.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'a', content: 'q2' }, serial: 's2' });
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'a', content: 'q1' }, serial: 's1' });

      const node = tree.getNode('u1');
      const messages = node ? testCodec.getMessages(node.projection).map((cm) => cm.message) : [];
      expect(messages).toEqual([
        { id: 'a', content: 'q1' },
        { id: 'a', content: 'q2' },
      ]);
    });

    it('isolates a throwing fold during a refold', () => {
      // Seed with a throwing event at the higher serial, then deliver a lower
      // serial to force a refold that replays the throwing event.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        events: [{ type: 'append-message', message: { id: 'b', content: 'second' } }, { type: 'throw' }],
        serial: 's2',
      });
      expect(() => {
        apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      }).not.toThrow();

      // Refold replays s1 then s2; the throwing event is skipped, the rest survive in serial order.
      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
      ]);
    });

    it('does not refold on a same-serial append at the tail', () => {
      // Two deliveries at the same serial (create + append) extend the tail
      // entry; the second folds incrementally rather than triggering a refold.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'b', content: 'append' }, serial: 's1' });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'append' },
      ]);
    });

    it('refolds on a late same-serial append to an earlier (non-tail) entry', () => {
      // s1 then s2 (in order), then a second delivery at s1 — an append to the
      // earlier, non-tail entry. Its events must land in canonical position
      // (within s1, before s2), which only the refold path produces.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 's1-first' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm2', message: { id: 'b', content: 's2' }, serial: 's2' });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'c', content: 's1-append' }, serial: 's1' });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 's1-first' },
        { id: 'c', content: 's1-append' },
        { id: 'b', content: 's2' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Version replay guard (decodedThrough)
  //
  // The per-entry `decodedThrough` high-water-mark is what dedups whole-wire
  // re-deliveries (a second hydration, a remounted View's re-fetch, an agent
  // re-walk) now that the agent's serial-keyed `_foldedSerials` is gone. It is
  // the *only* protection for a re-decoded discrete: the decoder keeps no
  // tracker for a single-wire discrete, so a replayed discrete reaches the
  // Tree fully decoded and must be dropped here.
  // -------------------------------------------------------------------------

  describe('version replay guard', () => {
    it('dedups a re-decoded discrete wire delivered twice (the stateless-decode path)', () => {
      // A discrete (non-streamed) wire: version.serial == serial (never-mutated).
      // The same wire arrives a second time via a history re-walk — same serial,
      // same version — and must fold exactly once.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        message: { id: 'a', content: 'first' },
        serial: 's1',
        version: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        message: { id: 'a', content: 'first' },
        serial: 's1',
        version: 's1',
      });

      expect(messagesOf(tree, 'R1')).toEqual([{ id: 'a', content: 'first' }]);
    });

    it('drops a replayed streamed delivery at or below the high-water-mark', () => {
      // Streamed create then append (advancing version) accumulate; replaying
      // either version folds nothing more.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        streamed: true,
        message: { id: 'a', content: 'create' },
        serial: 's1',
        version: 's1@1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        streamed: true,
        message: { id: 'b', content: 'append' },
        serial: 's1',
        version: 's1@2',
      });
      // Replay of the create's version (≤ decodedThrough) — dropped.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        streamed: true,
        message: { id: 'a', content: 'create' },
        serial: 's1',
        version: 's1@1',
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'create' },
        { id: 'b', content: 'append' },
      ]);
    });

    it('folds genuine streamed appends with advancing version', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        streamed: true,
        message: { id: 'a', content: 'create' },
        serial: 's1',
        version: 's1@1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        streamed: true,
        message: { id: 'b', content: 'append' },
        serial: 's1',
        version: 's1@2',
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'create' },
        { id: 'b', content: 'append' },
      ]);
    });

    it('drops a higher-version delivery for a discrete wire as an edited discrete, logging at debug', () => {
      const logged: { message: string; context?: Record<string, unknown> }[] = [];
      const logTree = createTree<TestInput, TestOutput, TestProjection>(
        testCodec,
        makeLogger({
          logLevel: LogLevel.Debug,
          logHandler: (message, _level, context) => logged.push({ message, context }),
        }),
      );

      logTree.applyMessage(
        { inputs: [], outputs: [{ type: 'append-message', message: { id: 'a', content: 'original' } }] },
        { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'm1' },
        's1',
        undefined,
        's1',
      );
      // A newer version of the same discrete (an edit) — propagation is out of
      // scope, so it is dropped and the projection is unchanged.
      logTree.applyMessage(
        { inputs: [], outputs: [{ type: 'append-message', message: { id: 'a', content: 'edited' } }] },
        { [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'm1' },
        's1',
        undefined,
        's1@2',
      );

      const run = logTree.getRunNode('R1');
      expect(run ? testCodec.getMessages(run.projection).map((m) => m.message) : []).toEqual([
        { id: 'a', content: 'original' },
      ]);
      expect(logged.some((l) => l.message.includes('version guard dropped re-delivered wire'))).toBe(true);
    });

    it('folds a version-less delivery unguarded (defensive path)', () => {
      // No version on either delivery (the type-optional absent case): the guard
      // is disabled, so both fold — matching the decoder's convention.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'again' }, serial: 's1' });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'a', content: 'again' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Optimistic promotion
  //
  // An optimistic (serial-less) seed folds into the projection but not the
  // log. The first serial-bearing wire (the echo) refolds the node from the
  // log alone, so the seed is discarded rather than folded on top of — a
  // codec needs no seed-replacement logic of its own.
  // -------------------------------------------------------------------------

  describe('optimistic promotion', () => {
    it('keeps the optimistic seed visible until its echo arrives', () => {
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u', content: 'seed' } });
      expect(inputMessagesOf(tree, 'u1')).toEqual([{ id: 'u', content: 'seed' }]);
    });

    it('refolds from the log on serial promotion, discarding the seed (no duplication)', () => {
      // Seed folds into the projection unlogged; the echo re-delivers the same
      // content with a serial. Without the refold the projection would hold
      // both; with it, only the echo survives.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u', content: 'seed' } });
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u', content: 'echo' }, serial: 's1' });

      expect(inputMessagesOf(tree, 'u1')).toEqual([{ id: 'u', content: 'echo' }]);
    });

    it('folds later wires incrementally once the seed has been promoted away', () => {
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u', content: 'seed' } });
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'a', content: 'echo' }, serial: 's1' });
      // A second serial-bearing wire is a normal tail append — no seed left to
      // discard, so it accumulates.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'b', content: 'more' }, serial: 's2' });

      expect(inputMessagesOf(tree, 'u1')).toEqual([
        { id: 'a', content: 'echo' },
        { id: 'b', content: 'more' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Event-log retention (sweep)
  // -------------------------------------------------------------------------

  describe('event-log retention', () => {
    const T = REORDER_WINDOW_MS;
    let warns: string[];

    beforeEach(() => {
      warns = [];
      tree = createTree<TestInput, TestOutput, TestProjection>(
        testCodec,
        makeLogger({
          logLevel: LogLevel.Warn,
          logHandler: (message, level) => {
            if (level === LogLevel.Warn) warns.push(message);
          },
        }),
      );
    });

    it('retains the log of a run whose run-start is unseen, regardless of age', () => {
      // R1 is created from a mid-run content wire — its run-start may still be
      // in an unloaded older history page, so its log must survive any amount
      // of clock advance.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1000,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1100);

      // Advance the clock far past the window.
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1100 + T * 3,
      });

      // The older page arrives: a lower-serial wire for R1 still refolds into
      // canonical position — the log was retained.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm12',
        message: { id: 'a', content: 'earlier' },
        serial: 's12',
        timestamp: 900,
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'earlier' },
        { id: 'b', content: 'later' },
      ]);
      expect(warns).toEqual([]);
    });

    it('does not sweep a run whose run-end is unseen, even when the clock passes its window', () => {
      // Forward hydration: R1's run-start and a content wire load (run still
      // open — no run-end). The clock then jumps far past R1's window via
      // another run. R1 is not structurally complete, so it is never queued and
      // must not be swept; its log survives for a later same-run wire to refold.
      lifecycle(tree, 'start', 'R1', 's10', 800);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1000,
      });
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1000 + T * 2,
      });

      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm12',
        message: { id: 'a', content: 'earlier' },
        serial: 's12',
        timestamp: 900,
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'earlier' },
        { id: 'b', content: 'later' },
      ]);
      expect(warns).toEqual([]);
    });

    it('sweeps a structurally complete run at the next clock advance, degrading later wires to arrival order', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1000,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1100);
      // The run-start loads from an older page (old timestamp): R1 is now
      // structurally complete and already aged, but nothing is swept until the
      // clock next advances.
      lifecycle(tree, 'start', 'R1', 's10', 800);

      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1100 + T + 1,
      });

      // The log is gone: a very late wire folds in arrival order with a warn.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm12',
        message: { id: 'a', content: 'earlier' },
        serial: 's12',
        timestamp: 900,
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'b', content: 'later' },
        { id: 'a', content: 'earlier' },
      ]);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('retention window');
    });

    it('drops a replayed discrete wire on a swept run instead of double-folding', () => {
      // A discrete output (no decoder tracker — the version guard's only
      // protection) folds once into R1.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'd', content: 'discrete' },
        serial: 's14',
        version: 's14',
        timestamp: 1000,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1100);
      lifecycle(tree, 'start', 'R1', 's10', 800);
      // Clock advances past the window: R1 is swept (events dropped, replay
      // key kept).
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1100 + T + 1,
      });

      // A loadOlder() re-applies R1's history: the identical discrete wire
      // (same serial + version) is a whole-wire replay. The retained replay
      // key must drop it rather than fold the part a second time.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'd', content: 'discrete' },
        serial: 's14',
        version: 's14',
        timestamp: 1000,
      });

      expect(messagesOf(tree, 'R1')).toEqual([{ id: 'd', content: 'discrete' }]);
      // A replay is a debug-level drop, not a degraded arrival-order fold.
      expect(warns).toEqual([]);
    });

    it('retains a complete run inside the reorder window and refolds its late wires', () => {
      lifecycle(tree, 'start', 'R1', 's10', 1000);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1100,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1200);

      // Clock advances to exactly the window boundary — not yet lapsed.
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1200 + T,
      });

      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm12',
        message: { id: 'a', content: 'earlier' },
        serial: 's12',
        timestamp: 1150,
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'earlier' },
        { id: 'b', content: 'later' },
      ]);
      expect(warns).toEqual([]);
    });

    it('does not sweep on applies carrying older timestamps (history pages never advance the clock)', () => {
      // Push the clock high first, then complete R1 with old timestamps: R1 is
      // aged and queued, but only a clock ADVANCE drains the queue.
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 10_000 + T,
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1000,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1100);
      lifecycle(tree, 'start', 'R1', 's10', 800);

      // An older-timestamp apply (a history page) must not trigger the sweep…
      apply(tree, {
        runId: 'R8',
        codecMessageId: 'y1',
        message: { id: 'y', content: 'old' },
        serial: 's50',
        timestamp: 5000,
      });
      // …so R1 still refolds canonically.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm12',
        message: { id: 'a', content: 'earlier' },
        serial: 's12',
        timestamp: 900,
      });
      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'earlier' },
        { id: 'b', content: 'later' },
      ]);
      expect(warns).toEqual([]);

      // A genuine clock advance drains the queue and sweeps R1.
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x2',
        message: { id: 'x2', content: 'live' },
        serial: 's100',
        timestamp: 10_000 + T + 1,
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm11',
        message: { id: 'c', content: 'earliest' },
        serial: 's11',
        timestamp: 850,
      });
      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'earlier' },
        { id: 'b', content: 'later' },
        { id: 'c', content: 'earliest' },
      ]);
      expect(warns).toHaveLength(1);
    });

    it('never sweeps input-node logs', () => {
      applyInput(tree, {
        codecMessageId: 'u1',
        message: { id: 'p2', content: 'part-2' },
        serial: 's2',
        timestamp: 1000,
      });

      // Age the world far past the window.
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1000 + T * 3,
      });

      // A late earlier part still refolds into canonical position.
      applyInput(tree, {
        codecMessageId: 'u1',
        message: { id: 'p1', content: 'part-1' },
        serial: 's1',
        timestamp: 900,
      });

      const node = tree.getNode('u1');
      const messages = node ? testCodec.getMessages(node.projection).map((cm) => cm.message) : [];
      expect(messages).toEqual([
        { id: 'p1', content: 'part-1' },
        { id: 'p2', content: 'part-2' },
      ]);
      expect(warns).toEqual([]);
    });

    it('does not resurrect a terminal run when its run-start is observed after run-end', () => {
      // History pages replay newest-first: the run-end is applied before the
      // run-start. The late start must not flip the status back to active.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1000,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1100);
      expect(tree.getRunNode('R1')?.state.status).toBe('complete');

      lifecycle(tree, 'start', 'R1', 's10', 800);
      expect(tree.getRunNode('R1')?.state.status).toBe('complete');
    });

    it('stays swept when its lifecycle events are replayed', () => {
      // Sweep R1, then replay its run-start and run-end (e.g. a redundant
      // history pass). The node must not re-queue or resume recording — a
      // partial rebuilt log would refold to partial state.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm14',
        message: { id: 'b', content: 'later' },
        serial: 's14',
        timestamp: 1000,
      });
      lifecycle(tree, 'end', 'R1', 's16', 1100);
      lifecycle(tree, 'start', 'R1', 's10', 800);
      apply(tree, {
        runId: 'R9',
        codecMessageId: 'x1',
        message: { id: 'x', content: 'live' },
        serial: 's99',
        timestamp: 1100 + T + 1,
      });

      lifecycle(tree, 'start', 'R1', 's10', 800);
      lifecycle(tree, 'end', 'R1', 's16', 1100);

      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm12',
        message: { id: 'a', content: 'earlier' },
        serial: 's12',
        timestamp: 900,
      });
      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'b', content: 'later' },
        { id: 'a', content: 'earlier' },
      ]);
      expect(warns).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // reorderWindowMs injection seam
    // -----------------------------------------------------------------------

    describe('reorderWindowMs injection seam', () => {
      it('sweeps a terminal, fully-settled run once a small injected window lapses', () => {
        const t = treeWithWindow(500, warns);
        // A fully-settled terminal run (run-start + run-end, no open step).
        apply(t, {
          runId: 'R1',
          codecMessageId: 'm14',
          message: { id: 'b', content: 'later' },
          serial: 's14',
          timestamp: 1000,
        });
        lifecycle(t, 'end', 'R1', 's16', 1100);
        lifecycle(t, 'start', 'R1', 's10', 800);

        // Advance the clock just past the 500ms window via unrelated traffic.
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x1',
          message: { id: 'x', content: 'live' },
          serial: 's99',
          timestamp: 1100 + 501,
        });

        // The log is gone: a late earlier-serial wire degrades to arrival order.
        apply(t, {
          runId: 'R1',
          codecMessageId: 'm12',
          message: { id: 'a', content: 'earlier' },
          serial: 's12',
          timestamp: 900,
        });
        expect(messagesOf(t, 'R1')).toEqual([
          { id: 'b', content: 'later' },
          { id: 'a', content: 'earlier' },
        ]);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('retention window');
      });

      it('does NOT sweep at that same small advance under the default window (default unchanged)', () => {
        // The describe-level `tree` uses the DEFAULT window (REORDER_WINDOW_MS).
        // The identical small clock advance the 500ms tree swept at is far
        // inside the default, so the log is retained and the late wire refolds.
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'm14',
          message: { id: 'b', content: 'later' },
          serial: 's14',
          timestamp: 1000,
        });
        lifecycle(tree, 'end', 'R1', 's16', 1100);
        lifecycle(tree, 'start', 'R1', 's10', 800);

        apply(tree, {
          runId: 'R9',
          codecMessageId: 'x1',
          message: { id: 'x', content: 'live' },
          serial: 's99',
          timestamp: 1100 + 501,
        });

        apply(tree, {
          runId: 'R1',
          codecMessageId: 'm12',
          message: { id: 'a', content: 'earlier' },
          serial: 's12',
          timestamp: 900,
        });
        expect(messagesOf(tree, 'R1')).toEqual([
          { id: 'a', content: 'earlier' },
          { id: 'b', content: 'later' },
        ]);
        expect(warns).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // Sweep-gate on step settlement
    // -----------------------------------------------------------------------

    describe('sweep-gate on step settlement', () => {
      // The gate is what a finite window alone cannot do — these tests shrink the
      // window so the clock can lapse it deterministically.
      it('does not sweep a terminal run with an OPEN step, so a late crash-reschedule supersedes (a finite window would have over-retained)', () => {
        const t = treeWithWindow(500, warns);
        // A terminal run whose only step's canonical attempt NEVER settled — the
        // worker died after ai-step-start, before ai-step-end. The run-end lands
        // (cleanup), but the step is unsettled.
        lifecycle(t, 'start', 'R1', 's1', 1000);
        applyStep(t, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's2', timestamp: 1000 });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's2',
          message: { id: 'm1', content: 'partial' },
          serial: 's3',
          timestamp: 1000,
        });
        lifecycle(t, 'end', 'R1', 's4', 1100);

        // Advance the clock far past the 500ms window via unrelated traffic. A
        // bare finite window would have swept R1 here; the unsettled-step floor
        // keeps the log so the dead attempt can still be superseded.
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x1',
          message: { id: 'x', content: 'live' },
          serial: 's99',
          timestamp: 1100 + 500 * 4,
        });
        // The log is retained — the dead attempt's partial output is still shown
        // (not yet superseded) and nothing degraded to arrival order.
        expect(idsOf(t, 'R1')).toEqual(['m1']);
        expect(warns).toEqual([]);

        // The rescheduled attempt arrives much later (higher start-serial, same
        // stepId): its step-start supersedes the s2 attempt and its output
        // replaces the dead partial — because the log was retained, the refold
        // drops m1 cleanly. Serials s8/s9 sort above the s2/s3 ones (single-digit,
        // so lexicographic order matches numeric order — `s100` would sort BELOW `s2`).
        applyStep(t, {
          type: 'step-start',
          runId: 'R1',
          stepId: 'S',
          serial: 's8',
          timestamp: 1100 + 500 * 4 + 1,
        });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's8',
          message: { id: 'm2', content: 'rescheduled' },
          serial: 's9',
          timestamp: 1100 + 500 * 4 + 2,
        });
        // Canonical advanced to the s8 attempt: only the rescheduled output is
        // retained, the dead attempt's partial is dropped (NOT over-retained), no warn.
        expect(idsOf(t, 'R1')).toEqual(['m2']);
        expect(warns).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // Re-queue on step settlement
    // -----------------------------------------------------------------------

    describe('re-queue on step settlement', () => {
      it('sweeps a held terminal-run-with-open-step once the step settles and the window lapses', () => {
        const t = treeWithWindow(500, warns);
        // Terminal run held un-swept by an open step (as above).
        lifecycle(t, 'start', 'R1', 's1', 1000);
        applyStep(t, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's2', timestamp: 1000 });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's2',
          message: { id: 'm1', content: 'x' },
          serial: 's3',
          timestamp: 1000,
        });
        lifecycle(t, 'end', 'R1', 's4', 1100);

        // Clock lapses the window while the step is still open: NOT swept (the
        // floor holds), so a late earlier-serial wire still refolds canonically.
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x1',
          message: { id: 'x', content: 'live' },
          serial: 's99',
          timestamp: 1100 + 501,
        });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's2',
          message: { id: 'm0', content: 'earlier' },
          serial: 's0',
          timestamp: 1000,
        });
        expect(idsOf(t, 'R1')).toEqual(['m0', 'm1']);
        expect(warns).toEqual([]);

        // The step now settles — this re-queues the now-fully-settled run.
        applyStep(t, { type: 'step-end', runId: 'R1', stepId: 'S', startSerial: 's2', serial: 's5', timestamp: 1100 });

        // A further clock advance past the window drains the queue and sweeps R1
        // (proving the step-end re-queued it): a very late wire degrades to
        // arrival order with the retention-window warn. R9's serial sorts above
        // its prior s99 (lexicographic) so R9's own log stays in order.
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x2',
          message: { id: 'x2', content: 'live' },
          serial: 't0',
          timestamp: 1100 + 501 + 600,
        });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's2',
          message: { id: 'm-1', content: 'earliest' },
          serial: 'r0',
          timestamp: 1000,
        });
        expect(idsOf(t, 'R1')).toEqual(['m0', 'm1', 'm-1']);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('retention window');
      });

      it('re-queues when a reordered step-start (end-before-start) settles the canonical on a held terminal run', () => {
        const t = treeWithWindow(500, warns);
        // Terminal run held by an OPEN canonical step A1 (worker died before its
        // ai-step-end), exactly as the crash-reschedule case.
        lifecycle(t, 'start', 'R1', 's1', 1000);
        applyStep(t, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's2', timestamp: 1000 });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's2',
          message: { id: 'm1', content: 'partial' },
          serial: 's3',
          timestamp: 1000,
        });
        lifecycle(t, 'end', 'R1', 's4', 1100);

        // Window lapses while the s2 attempt is open: held, not swept.
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x1',
          message: { id: 'x', content: 'live' },
          serial: 's90',
          timestamp: 1100 + 501,
        });
        expect(idsOf(t, 'R1')).toEqual(['m1']);
        expect(warns).toEqual([]);

        // The rescheduled attempt (start-serial s9) arrives REORDERED: its
        // step-END and output land before its step-START (cross-publisher
        // arrival). Both back-reference s9 — the start-serial the cleanup arm
        // closes, known regardless of arrival order. The step-end alone leaves
        // the canonical on the still-open s2 attempt, so the run stays held.
        applyStep(t, { type: 'step-end', runId: 'R1', stepId: 'S', startSerial: 's9', serial: 's7', timestamp: 1100 });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's9',
          message: { id: 'm2', content: 'rescheduled' },
          serial: 's8',
          timestamp: 1100,
        });
        // The s9 step-START lands last: it advances the canonical to that attempt,
        // whose end was already observed, so the run becomes fully settled via a
        // STEP-START. The re-queue must fire on the step-start (not only step-end)
        // or the run would never be queued — a fully-settled step retained forever.
        applyStep(t, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's9', timestamp: 1100 });
        expect(idsOf(t, 'R1')).toEqual(['m2']);
        expect(warns).toEqual([]);

        // A further clock advance drains the queue and sweeps R1, proving the
        // step-start re-queued it: a very late earlier-serial wire then degrades
        // to arrival order with the retention warn (it would refold canonically,
        // no warn, if the node had never been queued).
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x2',
          message: { id: 'x2', content: 'live' },
          serial: 't0',
          timestamp: 1100 + 501 + 600,
        });
        apply(t, {
          runId: 'R1',
          stepId: 'S',
          startSerial: 's9',
          message: { id: 'm-late', content: 'earliest' },
          serial: 'r0',
          timestamp: 1100,
        });
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('retention window');
      });
    });

    // -----------------------------------------------------------------------
    // arrival-order resilience under a shrunk window
    // -----------------------------------------------------------------------

    describe('arrival-order resilience under a shrunk window', () => {
      it('folds canonically when ai-run-end precedes a lower-serial late ai-output, clock advanced inside the window', () => {
        const t = treeWithWindow(500, warns);
        // The terminal arrives before a lower-serial stepless output (live
        // cross-publisher reorder). Both land inside the window, so the log
        // refolds the late output into canonical position.
        lifecycle(t, 'start', 'R1', 's1', 1000);
        apply(t, {
          runId: 'R1',
          codecMessageId: 'm2',
          message: { id: 'b', content: 'later' },
          serial: 's3',
          timestamp: 1100,
        });
        lifecycle(t, 'end', 'R1', 's4', 1150);

        // Clock advances by unrelated traffic but stays INSIDE the window
        // (1150 + 400 < 1150 + 500): R1 is not yet sweepable.
        apply(t, {
          runId: 'R9',
          codecMessageId: 'x1',
          message: { id: 'x', content: 'live' },
          serial: 's99',
          timestamp: 1150 + 400,
        });

        // The lower-serial late output refolds ahead of the higher-serial one.
        apply(t, {
          runId: 'R1',
          codecMessageId: 'm1',
          message: { id: 'a', content: 'earlier' },
          serial: 's2',
          timestamp: 1050,
        });
        expect(idsOf(t, 'R1')).toEqual(['a', 'b']);
        expect(warns).toEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // startSerial promotion
  // -------------------------------------------------------------------------

  describe('startSerial promotion', () => {
    it('promotes null startSerial to server-assigned serial', () => {
      // Optimistic insert (no serial)
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'optimistic' } });
      expect(tree.getRunNode('R1')?.startSerial).toBeUndefined();

      // Server relay with serial
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        message: { id: 'a', content: 'confirmed' },
        serial: 's10',
      });
      expect(tree.getRunNode('R1')?.startSerial).toBe('s10');
    });

    it('re-sorts after startSerial promotion', () => {
      // A linear chain: root reply R0, then a follow-up reply R1 parented at
      // R0's message. R1 arrives optimistically (no serial), then is promoted.
      // The sorted-list re-sort (`_removeSortedNode`/`_insertSortedNode` on the
      // promotion path) must keep R1 correctly positioned after its parent. In
      // the two-node model two reply runs sharing a parent would be regenerate
      // siblings, so they must chain rather than sit side-by-side as roots.
      apply(tree, { runId: 'R0', codecMessageId: 'm0', message: { id: 'a', content: 'first' }, serial: 's1' });
      // R1 optimistic (no serial) — tail-sorts initially, still after its parent.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', parent: 'm0', message: { id: 'b', content: 'second' } });
      expect(flatRunIds(tree)).toEqual(['R0', 'R1']);

      // R1 gets its real serial — the promotion re-sorts it into place.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        parent: 'm0',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });
      expect(flatRunIds(tree)).toEqual(['R0', 'R1']);
      expect(tree.getRunNode('R1')?.startSerial).toBe('s2');
    });

    it('does not demote an existing startSerial when subsequent applyMessage omits it', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'v1' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm2', parent: 'm1', message: { id: 'b', content: 'v2' } });
      expect(tree.getRunNode('R1')?.startSerial).toBe('s1');
    });

    it('reconciles an echo to the optimistic node by codec-message-id even when the wire run-id differs', () => {
      // Optimistic insert under R1 (no serial).
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'optimistic' } });
      expect(tree.getRunNode('R1')?.startSerial).toBeUndefined();

      // The echo arrives with a DIVERGENT run-id but the same codec-message-id
      // and a serial. It must reconcile to the optimistic R1 (promote it), not
      // spawn a second Run under the divergent id — reconciliation is by
      // codec-message-id, not the wire run-id.
      apply(tree, {
        runId: 'R2-divergent',
        codecMessageId: 'm1',
        message: { id: 'a', content: 'confirmed' },
        serial: 's10',
      });

      expect(tree.getRunNode('R1')?.startSerial).toBe('s10');
      expect(tree.getRunNode('R2-divergent')).toBeUndefined();
      // The codec-message-id stays indexed against the owning (reconciled) Run.
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      // The echo's events fold into the reconciled Run, not a phantom one.
      expect(messagesOf(tree, 'R1').map((m) => m.id)).toContain('a');
      expect(messagesOf(tree, 'R2-divergent')).toHaveLength(0);
    });

    it('does not reconcile by codec-message-id when the indexed Run is already serialized', () => {
      // R1 is established and serialized; it owns codec-message-id m1.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'v1' }, serial: 's1' });

      // A later message reuses m1 under a different run-id (the shape of a
      // continuation amend targeting a prior message). Because R1 is already
      // serialized — not an optimistic insert awaiting its echo — this routes
      // by the wire run-id and creates R2 rather than folding back into R1.
      apply(tree, { runId: 'R2', codecMessageId: 'm1', message: { id: 'b', content: 'amend' }, serial: 's2' });
      expect(tree.getRunNode('R2')).toBeDefined();
      expect(tree.getRunNode('R1')?.startSerial).toBe('s1');
    });
  });

  // -------------------------------------------------------------------------
  // Out-of-order inserts
  // -------------------------------------------------------------------------

  describe('out-of-order inserts', () => {
    it('produces correct flatten regardless of Run insertion order', () => {
      // Apply in reverse startSerial order.
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'third' },
        serial: 's3',
      });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      // R3 arrived first with parent=m2, but m2 (R2) hadn't been observed yet.
      // Reachability keys on the structural parentCodecMessageId, recorded at
      // create time. This is documented behaviour — out-of-order inserts may
      // produce disconnected Run forests when parents arrive late. The fix for
      // that is the history re-ingestion pass; for live channels parents
      // always arrive first. For this test we assert the flatten still includes
      // every Run in startSerial order.
      expect(flatRunIds(tree)).toContain('R1');
      expect(flatRunIds(tree)).toContain('R2');
      expect(flatRunIds(tree)).toContain('R3');
    });

    it('null-startSerial Runs sort after serial-bearing Runs', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      // R2 is optimistic.
      apply(tree, { runId: 'R2', codecMessageId: 'm2', parent: 'm1', message: { id: 'b', content: 'second' } });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2']);
    });

    it('null-startSerial Runs sort among themselves by insertion order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' } });
      apply(tree, { runId: 'R2', codecMessageId: 'm2', parent: 'm1', message: { id: 'b', content: 'second' } });
      apply(tree, { runId: 'R3', codecMessageId: 'm3', parent: 'm2', message: { id: 'c', content: 'third' } });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2', 'R3']);
    });
  });

  // -------------------------------------------------------------------------
  // Fork / regeneration
  // -------------------------------------------------------------------------

  describe('fork and regeneration', () => {
    beforeEach(() => {
      // Base chain: R1 (root) → R2 (child of R1).
      // role omitted so the user-content wire keeps routing at wire-runId
      // (the tree's role-based sub-Run split is verified in dedicated tests
      // below). These tests focus on parent/forkOf sibling semantics.
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'a', content: 'user-q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'assistant-v1' },
        serial: 's2',
      });
    });

    it('forkOf creates a sibling Run group sharing the input-node parent', () => {
      // Edit: new Run R2' with forkOf pointing at R2's user msg, same parentCodecMessageId.
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'assistant-v2' },
        serial: 's3',
      });

      expect(siblingRuns(tree, 'R2').length > 1).toBe(true);
      expect(siblingRuns(tree, 'R2alt').length > 1).toBe(true);

      const siblings = siblingRuns(tree, 'R2');
      expect(siblings).toHaveLength(2);
      expect(siblings.map((s) => s.runId)).toEqual(['R2', 'R2alt']);
    });

    it('default selection picks the latest sibling Run', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'assistant-v2' },
        serial: 's3',
      });

      // Latest sibling = R2alt → R2 is hidden.
      expect(flatRunIds(tree)).toEqual(['R1', 'R2alt']);
    });

    it('selections map controls which sibling Run is followed', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'assistant-v2' },
        serial: 's3',
      });

      const groupRoot = tree.getGroupRoot('R2');
      const selections = new Map([[groupRoot, 'R2']]);
      expect(flatRunIds(tree, selections)).toEqual(['R1', 'R2']);
    });

    it('stale selection runId falls back to latest sibling', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });

      const groupRoot = tree.getGroupRoot('R2');
      const stale = new Map([[groupRoot, 'R-nonexistent']]);
      expect(flatRunIds(tree, stale)).toEqual(['R1', 'R2alt']);
    });

    it('multiple forks create a larger sibling group', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R2alt2',
        codecMessageId: 'a3',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'd', content: 'v3' },
        serial: 's4',
      });

      const siblings = siblingRuns(tree, 'R2');
      expect(siblings.map((s) => s.runId)).toEqual(['R2', 'R2alt', 'R2alt2']);
    });

    it('transitive forkOf chain: alt2 forks alt1 which forks the original', () => {
      // Sibling group at R1's children, built as a chain:
      //   R2alt forks R2 (the original assistant a1)
      //   R2alt2 forks R2alt's assistant message (a2)
      // Group root is R2 (R2alt's forkOf is R2; R2alt2's forkOf is R2alt
      // which transitively roots at R2).
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R2alt2',
        codecMessageId: 'a3',
        parent: 'u1',
        forkOf: 'a2',
        message: { id: 'd', content: 'v3' },
        serial: 's4',
      });

      expect(tree.getRunNode('R2alt')?.forkOf).toBe('R2');
      expect(tree.getRunNode('R2alt2')?.forkOf).toBe('R2alt');
      expect(tree.getGroupRoot('R2alt2')).toBe('R2');
      expect(siblingRuns(tree, 'R2alt2').map((s) => s.runId)).toEqual(['R2', 'R2alt', 'R2alt2']);
    });

    it('cycle in forkOf chain is detected and does not infinite-loop', () => {
      // Construct a malformed pair where Ra and Rb forkOf each other's
      // codec-message-id. The Tree's sibling walk must terminate.
      apply(tree, {
        runId: 'Ra',
        codecMessageId: 'ma',
        parent: 'u1',
        forkOf: 'mb',
        message: { id: 'c', content: 'va' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'Rb',
        codecMessageId: 'mb',
        parent: 'u1',
        forkOf: 'ma',
        message: { id: 'd', content: 'vb' },
        serial: 's4',
      });

      // Both calls return without hanging; the exact membership depends on
      // walk-order, but the call terminates and includes both.
      const siblings = siblingRuns(tree, 'Ra').map((s) => s.runId);
      expect(siblings).toContain('Ra');
      expect(siblings.length).toBeGreaterThan(0);
    });

    it('descendants of non-selected sibling Run are excluded from flatten', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      // Descendant of R2alt
      apply(tree, {
        runId: 'R3alt',
        codecMessageId: 'a3',
        parent: 'a2',
        message: { id: 'd', content: 'after-v2' },
        serial: 's4',
      });
      // Descendant of R2 (original)
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a4',
        parent: 'a1',
        message: { id: 'e', content: 'after-v1' },
        serial: 's5',
      });

      // Default: latest sibling R2alt is selected, R3alt is its descendant.
      expect(flatRunIds(tree)).toEqual(['R1', 'R2alt', 'R3alt']);

      // Select original R2 → R3 (its descendant) becomes visible, R3alt hidden.
      const groupRoot = tree.getGroupRoot('R2');
      const selections = new Map([[groupRoot, 'R2']]);
      expect(flatRunIds(tree, selections)).toEqual(['R1', 'R2', 'R3']);
    });

    it('getGroupRoot returns the original Run in a fork chain', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      expect(tree.getGroupRoot('R2')).toBe('R2');
      expect(tree.getGroupRoot('R2alt')).toBe('R2');
    });

    it('getGroupRoot returns the runId itself for non-forked Runs', () => {
      expect(tree.getGroupRoot('R1')).toBe('R1');
    });

    it('getSiblingNodes returns empty for an unknown runId', () => {
      expect(siblingRuns(tree, 'R-unknown')).toEqual([]);
    });

    it('a Run with no forks has no sibling runs', () => {
      expect(siblingRuns(tree, 'R1').length > 1).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Regenerate groups (message-level)
  // -------------------------------------------------------------------------

  describe('regenerate groups', () => {
    it('records regeneratesCodecMessageId from the wire header', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply-2' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
    });

    it('records regenerates field from run-start lifecycle when no prior wire arrived', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        parent: 'a1',
        regenerates: 'a1',
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
    });

    it('backfills regenerates from run-start when the assistant wire raced ahead without the header', () => {
      // Race scenario: the assistant wire for R2 arrives BEFORE run-start
      // (e.g. history pagination boundary or out-of-order delivery), so
      // _createRunFromHeaders creates R2 without the regenerate metadata.
      // applyRunLifecycle must backfill the missing field once run-start
      // arrives — the alternative is the Run permanently lacking its
      // regenerate anchor.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      // R2's assistant wire arrives WITHOUT msg-regenerate.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        message: { id: 'asst2', content: 'regen' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBeUndefined();
      // run-start arrives later with the canonical metadata.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        parent: 'a1',
        regenerates: 'a1',
        serial: 's3',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
    });

    it('adopts the agent-minted invocation-id from run-start onto the optimistic node', () => {
      // The client no longer mints the invocation-id, so the optimistic
      // insert carries none — the Run starts with an empty invocationId. The
      // agent mints it and stamps it on run-start; applyRunLifecycle must
      // adopt it onto the existing node, otherwise the client-side
      // RunNode.invocationId would stay empty forever.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'optimistic' } });
      expect(tree.getRunNode('R1')?.invocationId).toBe('');

      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'agent-inv-1',
        serial: 's1',
      });
      expect(tree.getRunNode('R1')?.invocationId).toBe('agent-inv-1');

      // A later lifecycle event under the same run does not reassign it.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'agent-inv-2',
        serial: 's1',
      });
      expect(tree.getRunNode('R1')?.invocationId).toBe('agent-inv-1');
    });

    it('backfills the structural parentCodecMessageId from run-start when the assistant wire raced ahead of run-start', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'user1', content: 'q' },
        serial: 's1',
      });
      // R2's first wire (assistant) arrives WITHOUT parent.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.parentCodecMessageId).toBeUndefined();
      // run-start carries the parent header pointing at u1.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        parent: 'u1',
        serial: 's3',
      });
      // The two-node model backfills the structural parent codec-message-id;
      // reachability keys on it.
      expect(tree.getRunNode('R2')?.parentCodecMessageId).toBe('u1');
    });

    it('backfills parent and forkOf the same way for edit runs that raced ahead of run-start', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'user1', content: 'q' },
        serial: 's1',
      });
      // R2's user wire arrives WITHOUT parent / fork-of.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'u2',
        role: 'user',
        message: { id: 'user2', content: 'q-edit' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.parentCodecMessageId).toBeUndefined();
      expect(tree.getRunNode('R2')?.forkOf).toBeUndefined();
      // run-start carries the canonical edit metadata.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        forkOf: 'u1',
        serial: 's3',
      });
      expect(tree.getRunNode('R2')?.forkOf).toBe('R1');
    });

    it('a run-resume re-entry leaves an existing run a reachable root (no self-parent cycle)', () => {
      // Regression guard for the disappearing user prompt / assistant bubble:
      //   1. User sends u1 -> R1 created as a reachable root run.
      //   2. Agent streams a1 inside R1.
      //   3. A client-side tool resolution / approval re-enters R1.
      // Continuations now arrive as ai-run-resume, which carries no parent, so
      // there is nothing to backfill — R1 stays a reachable root. (Previously
      // the continuation arrived as a run-start carrying parent=a1, which the
      // backfill turned into a self-parent cycle that filtered R1 out.)
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'u1', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'a1', content: 'calling tool' },
        serial: 's2',
      });
      expect(tree.getRunNode('R1')?.parentCodecMessageId).toBeUndefined();

      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'inv-2',
        serial: 's3',
      });

      expect(tree.getRunNode('R1')?.parentCodecMessageId).toBeUndefined();
      const flat = replyRuns(tree, new Map());
      expect(flat.map((n) => n.runId)).toEqual(['R1']);
    });
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  describe('delete', () => {
    it('removes a Run from flatten', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      tree.delete('R2');
      expect(flatRunIds(tree)).toEqual(['R1']);
    });

    it('removes the Run from getRunNode', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      tree.delete('R1');
      expect(tree.getRunNode('R1')).toBeUndefined();
    });

    it('lingering codecMessageIdToRunId after delete returns undefined via getNodeByCodecMessageId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      tree.delete('R1');
      // The codecMessageIdToRunId entry intentionally lingers (cheap to overwrite on
      // re-creation, harmless otherwise) but the lookup must return
      // undefined now that the owning Run is gone.
      expect(tree.getNodeByCodecMessageId('m1')).toBeUndefined();
    });

    it('descendants become unreachable after parent Run delete', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'root' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'child' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'grandchild' },
        serial: 's3',
      });

      tree.delete('R1');
      // Children still exist but are unreachable via flatten.
      expect(flatRunIds(tree)).toEqual([]);
      expect(tree.getRunNode('R2')).toBeDefined();
      expect(tree.getRunNode('R3')).toBeDefined();
    });

    it('is a no-op for an unknown runId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      tree.delete('R-unknown');
      expect(flatRunIds(tree)).toEqual(['R1']);
    });

    it('shrinks the sibling group after deleting a sibling', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'v1' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });

      expect(siblingRuns(tree, 'R2')).toHaveLength(2);
      tree.delete('R2alt');
      expect(siblingRuns(tree, 'R2')).toHaveLength(1);
      expect(siblingRuns(tree, 'R2').length > 1).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Run lifecycle (applyRunLifecycle)
  // -------------------------------------------------------------------------

  describe('run lifecycle', () => {
    it('run-start creates a Run with status active when none exists', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      const run = tree.getRunNode('R1');
      expect(run?.state.status).toBe('active');
      expect(run?.startSerial).toBe('s1');
      // clientId is set on the RunNode itself, sourced from event.clientId.
      expect(run?.clientId).toBe('client-a');
    });

    it('run-start activates an existing Run created from message headers', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        clientId: 'client-a',
        message: { id: 'a', content: 'hi' },
        serial: 's1',
      });

      // RunNode.clientId was populated from the run-client-id header
      // on Run creation; run-start does not overwrite it.
      expect(tree.getRunNode('R1')?.clientId).toBe('client-a');

      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's2',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('active');
      expect(tree.getRunNode('R1')?.clientId).toBe('client-a');
    });

    it('run-end sets RunNode status and endSerial', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        reason: 'complete',
        serial: 's10',
      });
      const run = tree.getRunNode('R1');
      expect(run?.state.status).toBe('complete');
      expect(run?.endSerial).toBe('s10');
    });

    it('emits a run event on both start and end', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        reason: 'complete',
        serial: 's2',
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'start', runId: 'R1' }));
      expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'end', runId: 'R1' }));
    });

    it('run-suspend sets RunNode status to "suspended" and records endSerial', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      const run = tree.getRunNode('R1');
      expect(run?.state.status).toBe('suspended');
      expect(run?.endSerial).toBe('s5');
    });

    it('run-suspend keeps the run live so a subsequent run-start re-activates it', () => {
      // A suspended run must remain resumable: the continuation re-entry (a
      // following run-start under the same runId) flips it back to active.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('suspended');
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's1',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('active');
    });

    it('emits a run event on suspend', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'suspend', runId: 'R1' }));
    });

    it('run-resume re-activates a suspended run without changing its startSerial', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('suspended');

      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      const run = tree.getRunNode('R1');
      expect(run?.state.status).toBe('active');
      // Re-entry is not the start — the original startSerial is preserved.
      expect(run?.startSerial).toBe('s1');
    });

    it('run-resume for an unknown run is a no-op', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R-unknown',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      // No Run is created; the event still fires for observers.
      expect(tree.getRunNode('R-unknown')).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'resume', runId: 'R-unknown' }));
    });

    it('run-resume for a terminal run does not resurrect it', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
        reason: 'complete',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('complete');

      // A stray resume targeting an already-ended run must never flip it back
      // to active — only suspended runs resume.
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('complete');
    });

    it('emits a run event on resume', () => {
      const handler = vi.fn();
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'resume', runId: 'R1' }));
    });

    // The wire race: the previous invocation's suspend publish loses to the
    // next invocation's resume publish in wire order (concurrent Temporal
    // activities publishing to the same run). Applying the retired suspend
    // afterwards would wrongly flip a legitimately-active run back to
    // `suspended`. Guarded by the tree via lastResumeInvocationId matching.
    it('run-suspend from a retired invocation (after a newer resume) is skipped', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's5',
      });
      // Late-arriving suspend from the retired invocation-1. Must be
      // ignored — inv-2 has already taken over.
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's6',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('active');
    });

    // The active invocation's own suspend still applies — the guard filters
    // only retired invocations, not the current one publishing legitimately.
    it("run-suspend from the current active invocation applies (matches the run's latest resume)", () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's5',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('suspended');
    });

    // Before any resume the guard has nothing to compare against, so a first
    // suspend applies unconditionally — the pre-existing behaviour.
    it('run-suspend before any resume applies as before (no retired invocation to compare)', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('suspended');
    });

    // A suspend with an empty invocation-id can't be attributed to a specific
    // invocation, so the retired-invocation guard doesn't fire and the
    // suspend applies (matches the pre-existing behaviour for empty ids).
    it('run-suspend with an empty invocation-id applies even after a resume', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's5',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's6',
      });
      expect(tree.getRunNode('R1')?.state.status).toBe('suspended');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty tree returns empty flatten', () => {
      expect(flatRunIds(tree)).toEqual([]);
    });

    it('handles Runs with the same startSerial by insertion order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's1',
      });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2']);
    });

    it('applyMessage with an empty events array does not create a phantom Run (skipped)', () => {
      // Wire-only metadata-carrier messages (e.g. `ait-regenerate` whose
      // decoder produces zero events) must not create empty Runs in the
      // tree. The eventual assistant Run is created by run-start; if a
      // phantom Run lingered, it would inflate sibling-group counts.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', events: [], serial: 's1' });
      expect(tree.getRunNode('R1')).toBeUndefined();
    });

    it('applyMessage with empty events folds into an existing Run if present', () => {
      // Existing Run case: subsequent empty-events apply is a no-op but
      // the Run is unaffected (still in the tree, projection unchanged).
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const before = messagesOf(tree, 'R1');
      apply(tree, { runId: 'R1', codecMessageId: 'm2', events: [], serial: 's2' });
      expect(tree.getRunNode('R1')).toBeDefined();
      expect(messagesOf(tree, 'R1')).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe('events', () => {
    it('emits update when applyMessage creates a new Run', () => {
      const handler = vi.fn();
      tree.on('update', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalled();
    });

    it('emits output with routing metadata and the folded output events', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: undefined,
        codecMessageId: 'm1',
        serial: 's1',
        events: [{ type: 'append-message', message: { id: 'a', content: 'hi' } }],
        inputs: [],
      });
    });

    it('emits output carrying the triggering input-codec-message-id from the wire', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        inputCodecMessageId: 'u1',
        message: { id: 'a', content: 'hi' },
        serial: 's1',
      });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: 'u1',
        codecMessageId: 'm1',
        serial: 's1',
        events: [{ type: 'append-message', message: { id: 'a', content: 'hi' } }],
        inputs: [],
      });
    });

    it('emits output with empty events for an inputs-only fold', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        events: [{ kind: 'append-input', message: { id: 'a', content: 'hi' } }],
        serial: 's1',
      });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: undefined,
        codecMessageId: 'm1',
        serial: 's1',
        events: [],
        inputs: [{ kind: 'append-input', message: { id: 'a', content: 'hi' } }],
      });
    });

    it('emits output with undefined serial for an optimistic fold', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' } });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: undefined,
        codecMessageId: 'm1',
        serial: undefined,
        events: [{ type: 'append-message', message: { id: 'a', content: 'hi' } }],
        inputs: [],
      });
    });

    it('emits update on delete', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.delete('R1');
      expect(handler).toHaveBeenCalled();
    });

    it('emits update on a run-start that creates a Run, but not on the run-end', () => {
      // `update` is the structural channel: a run-start that creates a Run is
      // structural; a run-end only mutates status/endSerial on the existing
      // node (content, not structure) and emits no `update`. Lifecycle
      // observers use the `run` event for run-end.
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      expect(handler).toHaveBeenCalledTimes(1);
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'c',
        invocationId: '',
        reason: 'complete',
        serial: 's2',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not emit update on a run-suspend', () => {
      // Like run-end, a suspend only mutates status/endSerial on the existing
      // node (content, not structure), so it emits no `update`.
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'suspend', runId: 'R1', clientId: 'c', invocationId: '', serial: 's2' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit update on a run-resume', () => {
      // A resume only flips status back to 'active' (content, not structure),
      // so it emits no `update`.
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      tree.applyRunLifecycle({ type: 'suspend', runId: 'R1', clientId: 'c', invocationId: '', serial: 's2' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'resume', runId: 'R1', clientId: 'c', invocationId: '', serial: 's3' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit update on a run-start that only re-activates an existing Run', () => {
      // A repeat run-start for a Run that already exists with its startSerial
      // set and no new structural metadata flips status to active at most —
      // content, not structure — so it emits no `update`.
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit update on a content-only fold into an existing Run', () => {
      // The first apply creates the Run (structural → update). A subsequent
      // fold into the same Run changes only its projection (streaming
      // content), which flows through `output`, not `update`.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm2', message: { id: 'a', content: 'hi there' }, serial: 's2' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops delivery', () => {
      const handler = vi.fn();
      const unsub = tree.on('update', handler);
      unsub();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('emitAblyMessage forwards raw messages to ably-message subscribers', () => {
      const handler = vi.fn();
      tree.on('ably-message', handler);
      // Cast: the test doesn't need a fully-typed Ably.InboundMessage.
      const fakeMsg = { name: 'fake', data: 'x' } as unknown as Parameters<typeof tree.emitAblyMessage>[0];
      tree.emitAblyMessage(fakeMsg);
      expect(handler).toHaveBeenCalledWith(fakeMsg);
    });

    it('emits a step event on both step-start and step-end', () => {
      const handler = vi.fn();
      tree.on('step', handler);
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S1', serial: 's1', timestamp: 1000 });
      applyStep(tree, {
        type: 'step-end',
        runId: 'R1',
        stepId: 'S1',
        startSerial: 's1',
        serial: 's2',
        reason: 'complete',
        timestamp: 1100,
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ type: 'step-start', runId: 'R1', stepId: 'S1', timestamp: 1000 }),
      );
      expect(handler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: 'step-end', runId: 'R1', stepId: 'S1', reason: 'complete', timestamp: 1100 }),
      );
    });

    it('does not emit a step event for a step-end on an unknown run', () => {
      // A step-end for a run the tree has never observed is a no-op, mirroring
      // run-end on an unknown run — so no `step` event fires.
      const handler = vi.fn();
      tree.on('step', handler);
      applyStep(tree, { type: 'step-end', runId: 'R-unknown', stepId: 'S1', serial: 's1', reason: 'complete' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops step delivery', () => {
      const handler = vi.fn();
      const unsub = tree.on('step', handler);
      unsub();
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S1', serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Two-node reachability (kind-blind)
  // -------------------------------------------------------------------------

  describe('two-node reachability', () => {
    it('walks a seed user→user→user chain then a reply run, kind-blind', () => {
      // Seeds are run-less input nodes chained by parent (input→input→input);
      // the reply run parents at the last input node. Reachability is
      // structural (parentCodecMessageId), so it threads input and run nodes
      // through the same path — no run-id between the user turns.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'one' }, serial: 's1' });
      applyInput(tree, { codecMessageId: 'u2', parent: 'u1', message: { id: 'u2', content: 'two' }, serial: 's2' });
      applyInput(tree, { codecMessageId: 'u3', parent: 'u2', message: { id: 'u3', content: 'three' }, serial: 's3' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u3',
        role: 'assistant',
        message: { id: 'a1', content: 'reply' },
        serial: 's4',
      });

      expect(visibleKeys(tree)).toEqual(['u1', 'u2', 'u3', 'R1']);
      expect(
        tree
          .visibleNodes(NO_SELECTIONS)
          .flatMap((n) => testCodec.getMessages(n.projection))
          .map((m) => m.message.id),
      ).toEqual(['u1', 'u2', 'u3', 'a1']);
      // The reply run resolves its input-node parent via the reverse edge.
      expect(tree.getReplyRuns('u3').map((r) => r.runId)).toEqual(['R1']);
      // runs() surfaces reply runs only.
      expect(flatRunIds(tree)).toEqual(['R1']);
    });
  });

  // -------------------------------------------------------------------------
  // Step retry precedence: the latest-serial step-start is the canonical
  // attempt; only its output materialises into the run projection.
  // -------------------------------------------------------------------------
  describe('step precedence', () => {
    it('folds a single step attempt normally', () => {
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      apply(tree, { runId: 'R1', stepId: 'S', startSerial: 's1', message: { id: 'm1', content: 'x' }, serial: 's2' });

      expect(idsOf(tree, 'R1')).toEqual(['m1']);
    });

    it('supersedes an earlier attempt when a later-serial step-start arrives (retry)', () => {
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's1',
        message: { id: 'm1', content: 'partial' },
        serial: 's2',
      });
      expect(idsOf(tree, 'R1')).toEqual(['m1']);

      // Retry: same stepId, fresh start-serial, higher-serial start supersedes A1.
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's3' });
      // A1's already-folded output is dropped by the supersede refold.
      expect(idsOf(tree, 'R1')).toEqual([]);

      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's3',
        message: { id: 'm2', content: 'full' },
        serial: 's4',
      });
      expect(idsOf(tree, 'R1')).toEqual(['m2']);
    });

    it('drops a superseded attempt whose output arrives LATE (earlier serial, forcing a refold)', () => {
      // Canonical attempt (start-serial s3) established first; its output folds.
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's3' });
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's3',
        message: { id: 'm2', content: 'full' },
        serial: 's4',
      });
      expect(idsOf(tree, 'R1')).toEqual(['m2']);

      // The s1 attempt's output arrives late with a LOWER serial than m2 — this
      // forces a whole-log refold. The refold must see this wire's own
      // attribution (recorded before the fold) and gate it as the non-canonical
      // attempt, so m1 never appears.
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's1',
        message: { id: 'm1', content: 'stale' },
        serial: 's2',
      });
      expect(idsOf(tree, 'R1')).toEqual(['m2']);
    });

    it('does not gate an optimistic (serial-less) step-start before its echo', () => {
      // The agent seeds its own step-start optimistically (no serial), then
      // streams output, then the wire echo promotes the start's serial. The
      // optimistic seed and its echo share the same start-serial (the ACK).
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: undefined });
      apply(tree, { runId: 'R1', stepId: 'S', startSerial: 's1', message: { id: 'm1', content: 'x' }, serial: 's2' });
      expect(idsOf(tree, 'R1')).toEqual(['m1']);

      // Echo of the same start with the concrete serial — same attempt, promotes
      // the serial, no refold, output stays.
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      expect(idsOf(tree, 'R1')).toEqual(['m1']);
    });

    it('keeps distinct stepIds independent (no cross-step precedence)', () => {
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S1', serial: 's1' });
      apply(tree, { runId: 'R1', stepId: 'S1', startSerial: 's1', message: { id: 'm1', content: '1' }, serial: 's2' });
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S2', serial: 's3' });
      apply(tree, { runId: 'R1', stepId: 'S2', startSerial: 's3', message: { id: 'm2', content: '2' }, serial: 's4' });

      // Both steps' output materialises — a later step never supersedes an
      // earlier, different step.
      expect(idsOf(tree, 'R1')).toEqual(['m1', 'm2']);
    });

    it('emits a projection-changed output (empty events) on a supersede so consumers repaint', () => {
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      apply(tree, { runId: 'R1', stepId: 'S', startSerial: 's1', message: { id: 'm1', content: 'x' }, serial: 's2' });

      const outputs: OutputEvent<TestOutput>[] = [];
      tree.on('output', (e) => outputs.push(e));

      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's3' });

      const repaint = outputs.find((e) => e.runId === 'R1' && e.events.length === 0);
      expect(repaint).toBeDefined();
    });

    it('suppresses the output emit for a known-superseded attempt', () => {
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's3' });

      const outputs: OutputEvent<TestOutput>[] = [];
      tree.on('output', (e) => outputs.push(e));

      // Output for the already-superseded s1 attempt — must neither fold nor emit.
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's1',
        message: { id: 'm1', content: 'stale' },
        serial: 's2',
      });
      expect(idsOf(tree, 'R1')).toEqual([]);
      expect(outputs.filter((e) => e.events.length > 0)).toHaveLength(0);
    });

    it('re-streams a step under the SAME stepId (fresh start-serial) without double-output', () => {
      // A re-execution of the same logical step that re-publishes its OWN
      // output under a fresh `ai-step-start` (a new serial). Each output carries
      // a DISTINCT codec-message-id (per-pipe random), so the version guard
      // cannot dedup the two — only the start-serial supersede can. Because
      // every step-start has a distinct serial, the later start supersedes the
      // earlier attempt and exactly one output survives. (Keyed on a single
      // developer-supplied id, both would have folded — a double-output.)
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's1',
        message: { id: 'cm-a', content: 'first' },
        serial: 's2',
      });
      expect(idsOf(tree, 'R1')).toEqual(['cm-a']);

      // Re-stream: fresh step-start (higher serial) under the same stepId, then
      // its own freshly-identified output.
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's3' });
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's3',
        message: { id: 'cm-b', content: 'second' },
        serial: 's4',
      });

      // Exactly one output — the canonical (later-serial) attempt's. The first
      // attempt's `cm-a` is gated out by the supersede, NOT double-folded.
      expect(idsOf(tree, 'R1')).toEqual(['cm-b']);
      expect(tree.getRunNode('R1')?.steps[0]?.attemptCount).toBe(2);
    });

    it('does not blank the projection when a supersede arrives after the log was swept', () => {
      // Build a structurally complete, retention-eligible run, then sweep it.
      const T = REORDER_WINDOW_MS;
      lifecycle(tree, 'start', 'R1', 's1', 1000);
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's2', timestamp: 1000 });
      apply(tree, {
        runId: 'R1',
        stepId: 'S',
        startSerial: 's2',
        message: { id: 'm1', content: 'x' },
        serial: 's3',
        timestamp: 1000,
      });
      applyStep(tree, { type: 'step-end', runId: 'R1', stepId: 'S', startSerial: 's2', serial: 's4', timestamp: 1000 });
      lifecycle(tree, 'end', 'R1', 's5', 1000);
      // Advance the clock past the reorder window on an unrelated node to sweep R1.
      lifecycle(tree, 'start', 'R2', 's6', 1000 + T + 1);
      expect(idsOf(tree, 'R1')).toEqual(['m1']);

      // A late superseding step-start cannot refold a swept log — over-retain
      // m1 rather than blank the projection.
      applyStep(tree, {
        type: 'step-start',
        runId: 'R1',
        stepId: 'S',
        serial: 's7',
        timestamp: 1000 + T + 2,
      });
      expect(idsOf(tree, 'R1')).toEqual(['m1']);
    });

    it('exposes a steps read-model reflecting the canonical attempt and attempt count', () => {
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's1' });
      applyStep(tree, {
        type: 'step-end',
        runId: 'R1',
        stepId: 'S',
        startSerial: 's1',
        serial: 's2',
        reason: 'failed',
      });
      applyStep(tree, { type: 'step-start', runId: 'R1', stepId: 'S', serial: 's3' });

      let steps = tree.getRunNode('R1')?.steps ?? [];
      expect(steps).toHaveLength(1);
      // attemptCount counts distinct start-serials (s1, s2-back-ref, s3) = 2
      // physical attempts. stepClientId is the empty string here (applyStep
      // defaults it); a dedicated test below asserts a non-empty value surfaces
      // and tracks the canonical attempt.
      expect(steps[0]).toEqual({ stepId: 'S', status: 'active', attemptCount: 2, stepClientId: '' });

      applyStep(tree, {
        type: 'step-end',
        runId: 'R1',
        stepId: 'S',
        startSerial: 's3',
        serial: 's4',
        reason: 'complete',
      });
      steps = tree.getRunNode('R1')?.steps ?? [];
      // Status reflects the CANONICAL attempt (start-serial s3), which completed.
      expect(steps[0]).toEqual({ stepId: 'S', status: 'complete', attemptCount: 2, stepClientId: '' });
    });

    it('surfaces stepClientId from the canonical attempt and tracks it across a supersede', () => {
      // The canonical attempt's step-client-id is the one surfaced. The s1
      // attempt is canonical first (client user-a); a later-serial s3 attempt
      // (client user-b) supersedes it, so the read-model tracks s3's client.
      applyStep(tree, {
        type: 'step-start',
        runId: 'R1',
        stepId: 'S',
        serial: 's1',
        stepClientId: 'user-a',
      });
      expect(tree.getRunNode('R1')?.steps[0]?.stepClientId).toBe('user-a');

      applyStep(tree, {
        type: 'step-start',
        runId: 'R1',
        stepId: 'S',
        serial: 's3',
        stepClientId: 'user-b',
      });
      // The later-serial step-start is canonical, so its client is surfaced.
      expect(tree.getRunNode('R1')?.steps[0]?.stepClientId).toBe('user-b');
    });

    it('leaves stepClientId undefined for a step seen only via an out-of-order step-end', () => {
      // The run node must already exist for a step-end to record (a step-end for
      // an unknown run is a no-op, like run-end). Seed it via an output wire,
      // then deliver an out-of-order step-end: the attempt is recorded but there
      // is no canonical step-start, so there is no client to surface yet.
      apply(tree, { runId: 'R1', message: { id: 'a1', content: '1' }, serial: 's1' });
      applyStep(tree, {
        type: 'step-end',
        runId: 'R1',
        stepId: 'S',
        startSerial: 's2',
        serial: 's2',
        reason: 'complete',
      });
      const step = tree.getRunNode('R1')?.steps[0];
      expect(step?.stepId).toBe('S');
      expect(step?.stepClientId).toBeUndefined();
    });

    it('leaves stepless run output and input-node folds unchanged (gate is the identity)', () => {
      // A stepless reply run: outputs carry no step-id/start-serial and all fold.
      apply(tree, { runId: 'R1', message: { id: 'a1', content: '1' }, serial: 's1' });
      apply(tree, { runId: 'R1', message: { id: 'a2', content: '2' }, serial: 's2' });
      expect(idsOf(tree, 'R1')).toEqual(['a1', 'a2']);
      // No step state is allocated on a stepless run.
      expect(tree.getRunNode('R1')?.steps).toEqual([]);

      // An input node folds normally and never carries step state.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'hi' }, serial: 's3' });
      expect(inputMessagesOf(tree, 'u1').map((m) => m.id)).toEqual(['u1']);
    });
  });
});
