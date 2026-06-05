import type * as Ably from 'ably';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type { Codec, CodecInputEvent, ReducerMeta } from '../../../src/core/codec/types.js';
// Vitest hoists vi.mock above imports, so this static import gets the mock.
import { decodeHistory } from '../../../src/core/transport/decode-history.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import type { DefaultTree } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { ActiveRun, HistoryPage, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import type { SendDelegate } from '../../../src/core/transport/view.js';
import { DefaultView } from '../../../src/core/transport/view.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

vi.mock('../../../src/core/transport/decode-history.js', () => ({
  decodeHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test codec
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

/**
 * Test inputs published by the client. All variants extend
 * {@link CodecInputEvent} so routing fields (`parent`, `target`,
 * `codecMessageId`) propagate through the transport.
 */
type TestInput =
  | ({ kind: 'user-message'; message: TestMessage } & CodecInputEvent)
  | ({ kind: 'regenerate'; target: string; parent: string } & CodecInputEvent);

/** Test outputs published by the agent. */
interface TestOutput {
  type: 'append-message';
  message: TestMessage;
}

interface TestProjection {
  messages: TestMessage[];
}

const makeTestCodec = (): Codec<TestInput, TestOutput, TestProjection, TestMessage> => ({
  init: () => ({ messages: [] }),
  fold: (state: TestProjection, event: TestInput | TestOutput, meta: ReducerMeta) => {
    if ('type' in event) {
      // TestOutput has a single variant — append-message — so the type check
      // is sufficient; just stamp the wire codec-message-id onto TMessage.id.
      const msg = meta.messageId ? { ...event.message, id: meta.messageId } : event.message;
      return { messages: [...state.messages, msg] };
    }
    if (event.kind === 'user-message') {
      // Codec convention: TMessage.id == wire codec-message-id from meta.messageId.
      const msg = meta.messageId ? { ...event.message, id: meta.messageId } : event.message;
      return { messages: [...state.messages, msg] };
    }
    return state;
  },
  getMessages: (projection: TestProjection) => projection.messages,
  createEncoder: () => {
    throw new Error('not used in view tests');
  },
  createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
  createUserMessage: (message: TestMessage) => ({ kind: 'user-message' as const, message }),
  createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }),
});

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Mock channel and helpers
// ---------------------------------------------------------------------------

const createMockChannel = (): Ably.RealtimeChannel =>
  // CAST: Tests only call history()/attach() — the full RealtimeChannel surface isn't needed.
  ({
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => Promise.resolve({ items: [], hasNext: () => false, next: () => Promise.resolve() })),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
  }) as unknown as Ably.RealtimeChannel;

const createMockSendDelegate = (): SendDelegate<TestInput> =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  vi.fn(() =>
    Promise.resolve({
      key: 'mock-input',
      runId: Promise.resolve('mock-run'),
      inputEventId: '',
      invocationId: 'mock-inv',
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      cancel: () => Promise.resolve(),
      optimisticCodecMessageIds: [],
      toInvocation: () => Invocation.fromJSON({ runId: 'mock-run', inputEventId: '', sessionName: 'test' }),
    }),
  );

interface ApplyOpts {
  runId: string;
  codecMessageId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  role?: string;
  invocationId?: string;
  serial?: string;
  message?: TestMessage;
}

const apply = (tree: DefaultTree<TestInput, TestOutput, TestProjection>, opts: ApplyOpts): void => {
  const h: Record<string, string> = { [HEADER_RUN_ID]: opts.runId };
  if (opts.codecMessageId) h[HEADER_CODEC_MESSAGE_ID] = opts.codecMessageId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h['msg-regenerate'] = opts.regenerates;
  if (opts.role) h[HEADER_ROLE] = opts.role;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  const events: TestOutput[] = opts.message ? [{ type: 'append-message', message: opts.message }] : [];
  tree.applyMessage({ inputs: [], outputs: events }, h, opts.serial);
};

interface ApplyInputOpts {
  /** The input node's codec-message-id (its primary key). */
  codecMessageId: string;
  /** Structural parent codec-message-id (the preceding reply run), if any. */
  parent?: string;
  /** Fork-of anchor when this input is an edit of an earlier prompt. */
  forkOf?: string;
  serial?: string;
  message: TestMessage;
}

/**
 * Apply a run-less user INPUT node (two-node model): no run-id, role 'user',
 * keyed by its codec-message-id, carrying a user input event. The agent mints
 * the reply run-id separately as a child RunNode parented at this input.
 * @param tree - The tree to apply the input node to.
 * @param opts - Input node options (codecMessageId, parent, forkOf, serial, message).
 */
const applyInput = (tree: DefaultTree<TestInput, TestOutput, TestProjection>, opts: ApplyInputOpts): void => {
  const h: Record<string, string> = {
    [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId,
    [HEADER_ROLE]: 'user',
  };
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  const inputs: TestInput[] = [{ kind: 'user-message', message: opts.message }];
  tree.applyMessage({ inputs, outputs: [] }, h, opts.serial);
};

const makePage = (
  items: { message: TestMessage; headers: Record<string, string>; serial: string }[],
  rawMessages: Ably.InboundMessage[] = [],
  hasNextPage = false,
  nextPageFn?: () => Promise<HistoryPage<TestMessage> | undefined>,
): HistoryPage<TestMessage> => ({
  items,
  rawMessages,
  hasNext: () => hasNextPage,
  // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock needs explicit undefined return for HistoryPage shape
  next: nextPageFn ?? (() => Promise.resolve(undefined)),
});

/**
 * Build a linear-chain run's transport headers for the pagination history
 * fixtures: each run parents at the prior run's message so they stay a visible
 * chain (same-parent reply runs would collapse as regenerate siblings).
 * @param i - The run index (0 = root).
 * @returns The transport headers for run `i`.
 */
const linearChainHeaders = (i: number): Record<string, string> => {
  const h: Record<string, string> = {
    [HEADER_RUN_ID]: `R${String(i)}`,
    [HEADER_CODEC_MESSAGE_ID]: `mh${String(i)}`,
  };
  if (i > 0) h[HEADER_PARENT] = `mh${String(i - 1)}`;
  return h;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultView', () => {
  let tree: DefaultTree<TestInput, TestOutput, TestProjection>;
  let view: DefaultView<TestInput, TestOutput, TestProjection, TestMessage>;
  let sendDelegate: SendDelegate<TestInput>;
  let codec: Codec<TestInput, TestOutput, TestProjection, TestMessage>;

  beforeEach(() => {
    vi.mocked(decodeHistory).mockReset();
    codec = makeTestCodec();
    tree = createTree<TestInput, TestOutput, TestProjection>(codec, silentLogger);
    sendDelegate = createMockSendDelegate();
    view = new DefaultView({
      tree,
      channel: createMockChannel(),
      codec,
      sendDelegate,
      logger: silentLogger,
    });
  });

  // -------------------------------------------------------------------------
  // runs and getMessages
  // -------------------------------------------------------------------------

  describe('runs and getMessages', () => {
    it('returns RunNode[] along the visible chain', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      const nodes = view.runs();
      expect(nodes.map((n) => n.runId)).toEqual(['R1', 'R2']);
    });

    it("getMessages concatenates each Run's codec.getMessages output", () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q1' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'a1' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'q2' },
        serial: 's3',
      });

      // The codec convention rebinds each TMessage.id to the wire codecMessageId.
      expect(view.getMessages()).toEqual([
        { id: 'm1', content: 'q1' },
        { id: 'm2', content: 'a1' },
        { id: 'm3', content: 'q2' },
      ]);
    });

    it('returns an empty list for an empty tree', () => {
      expect(view.runs()).toEqual([]);
      expect(view.getMessages()).toEqual([]);
    });

    it('keeps messages visible after a run-resume re-entry (no self-parent cycle)', () => {
      // Repro for the user-reported regression where invoking a client-side
      // tool (getLocation) or approving an approval-gated tool made both the
      // user prompt and the assistant bubble vanish from the visible message
      // list. The continuation re-enters the run; it now arrives as
      // ai-run-resume, which carries no `parent`, so the run is not re-parented
      // into a self-cycle and stays visible. (Previously the continuation
      // arrived as a run-start carrying parent pointing into the same Run.)
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

      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'inv-2',
        serial: 's3',
      });

      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
    });

    it('hides follow-up Runs parented at a regen-substituted assistant', () => {
      // P1 was sent (R1 has [u1, a1]), then P2 was sent parented off
      // a1 (R2 has [u2, a2]). Then a1 is regenerated, creating R3
      // with [a1']. The follow-up R2 was conditioned on the original
      // a1 — its answer doesn't apply to a1', so the visible chain on
      // the regen branch collapses to [u1, a1']. The follow-up turn
      // reappears when the user navigates back to the original branch.
      // Two-node model: u1 input → R1 reply (a1). Follow-up turn: u2 input
      // parented at a1 → R2 reply (a2). Regenerate a1 → R3 reply parented at the
      // same input node u1 (regenerate sibling of R1).
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u1',
        role: 'assistant',
        message: { id: 'a1', content: 'reply1' },
        serial: 's2',
      });
      applyInput(tree, { codecMessageId: 'u2', parent: 'a1', message: { id: 'u2', content: 'q2' }, serial: 's3' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'u2',
        role: 'assistant',
        message: { id: 'a2', content: 'reply2' },
        serial: 's4',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a1p',
        parent: 'u1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'a1p', content: 'reply1-regen' },
        serial: 's5',
      });

      // Regen branch (default — latest): the follow-up turn (u2 + R2) is hidden
      // because its anchor a1 (R1's reply) is no longer on the selected path.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

      // Original branch: a1 is back in the chain, the follow-up turn reappears.
      view.selectSibling('a1', 0);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });

    // TODO(AIT-831): deferred — regenerating a NON-HEAD message inside a
    // multi-message reply run's projection. The two-node node-walk selects a
    // whole sibling reply run; it can't slice inside one run's projection, so
    // intra-run mid-reply substitution is out of scope for the flip. Re-enable
    // with the planned regenerate-of-multi-message golden test (see
    // pr2-execution-plan.md §Tests).
    it.skip('substitutes nested regenerator content recursively at each anchor position', () => {
      // P1 → [u1, a1]. Regen a1 → R2 = [a1', extra']. Then regen the
      // trailing follow-up extra' inside R2 → R3 = [extra''] (anchored
      // at extra', NOT rebased to a1 per the trailing-target rule).
      // Walking R1 hits a1 → substitute R2 → emits a1', then hits
      // extra' → substitute R3 → emits extra''. Final chain:
      // [u1, a1', extra''].
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
        message: { id: 'a1', content: 'orig' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1p',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'a1p', content: 'regen-1' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'extra',
        role: 'assistant',
        message: { id: 'extra', content: 'extra-1' },
        serial: 's4',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'extrap',
        regenerates: 'extra',
        role: 'assistant',
        message: { id: 'extrap', content: 'regen-extra' },
        serial: 's5',
      });

      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'extrap']);
    });

    // -----------------------------------------------------------------------
    // Cross-Run concat edge cases (AIT-773 §2.3)
    // -----------------------------------------------------------------------

    it('includes a Run that has zero messages in runs() but contributes no messages to getMessages', () => {
      // A "zero-message" Run can exist transiently: the agent's
      // `ai-run-start` lifecycle created the Run but no codec events
      // have folded in yet (regenerate Runs spend their first
      // microseconds in this state).
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        message: { id: 'u1', content: 'q' },
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R_empty',
        clientId: '',
        invocationId: '',
        parent: 'u1',
        serial: 's2',
      });

      // Both Runs flatten; only R1 has messages so getMessages reflects
      // R1's content with no gap or undefined entry for R_empty.
      expect(view.runs().map((n) => n.runId)).toEqual(['R1', 'R_empty']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1']);
    });

    it('preserves per-Run order across many-message Runs', () => {
      // A Run can carry several messages (e.g. user + assistant text
      // + tool call + tool result + continuation assistant text). The
      // codec folds them in publish order; the View must concatenate
      // each Run's messages in that order, then concatenate across
      // Runs by the structural parent chain.
      apply(tree, { runId: 'R1', codecMessageId: 'a', message: { id: 'a', content: 'a-1' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'b', message: { id: 'b', content: 'a-2' }, serial: 's2' });
      apply(tree, { runId: 'R1', codecMessageId: 'c', message: { id: 'c', content: 'a-3' }, serial: 's3' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'd',
        parent: 'c',
        message: { id: 'd', content: 'b-1' },
        serial: 's4',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'e',
        parent: 'd',
        message: { id: 'e', content: 'b-2' },
        serial: 's5',
      });

      expect(view.getMessages().map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('flattens a five-turn linear conversation in publish order', () => {
      // Multi-turn baseline: five user+assistant turns.
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's01' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'a1', content: 'r1' },
        serial: 's02',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'u2',
        parent: 'a1',
        message: { id: 'u2', content: 'q2' },
        serial: 's03',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'u2',
        message: { id: 'a2', content: 'r2' },
        serial: 's04',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'u3',
        parent: 'a2',
        message: { id: 'u3', content: 'q3' },
        serial: 's05',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a3',
        parent: 'u3',
        message: { id: 'a3', content: 'r3' },
        serial: 's06',
      });
      apply(tree, {
        runId: 'R4',
        codecMessageId: 'u4',
        parent: 'a3',
        message: { id: 'u4', content: 'q4' },
        serial: 's07',
      });
      apply(tree, {
        runId: 'R4',
        codecMessageId: 'a4',
        parent: 'u4',
        message: { id: 'a4', content: 'r4' },
        serial: 's08',
      });
      apply(tree, {
        runId: 'R5',
        codecMessageId: 'u5',
        parent: 'a4',
        message: { id: 'u5', content: 'q5' },
        serial: 's09',
      });
      apply(tree, {
        runId: 'R5',
        codecMessageId: 'a5',
        parent: 'u5',
        message: { id: 'a5', content: 'r5' },
        serial: 's10',
      });

      expect(view.runs().map((n) => n.runId)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    });
  });

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  describe('query methods', () => {
    beforeEach(() => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'a' },
        serial: 's2',
      });
    });

    it('run() returns the Run by runId', () => {
      expect(view.run('R1')?.runId).toBe('R1');
      expect(view.run('R-unknown')).toBeUndefined();
    });

    it('runOf resolves the owning Run', () => {
      expect(view.runOf('m1')?.runId).toBe('R1');
      expect(view.runOf('m2')?.runId).toBe('R2');
      expect(view.runOf('m-unknown')).toBeUndefined();
    });

    it("runOf reports 'active' status while the Run is active", () => {
      expect(view.runOf('m1')?.status).toBe('active');
    });

    it('runOf surfaces the terminal RunEndReason on the Run', () => {
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'c',
        invocationId: '',
        reason: 'cancelled',
        serial: 's3',
      });
      expect(view.runOf('m1')?.status).toBe('cancelled');

      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R2',
        clientId: 'c',
        invocationId: '',
        reason: 'complete',
        serial: 's4',
      });
      expect(view.runOf('m2')?.status).toBe('complete');
    });
  });

  // -------------------------------------------------------------------------
  // Branch selection
  // -------------------------------------------------------------------------

  describe('branch selection', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- closure captures `tree` from outer beforeEach
    const seedFork = (): void => {
      // role omitted so the user-content wire keeps routing at wire-runId
      // (the role-based sub-Run split is verified elsewhere). These tests
      // focus on parent/forkOf sibling-selection semantics.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        message: { id: 'a', content: 'user-q' },
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
    };

    /**
     * Create a fresh view AFTER seeding so the View walks an already-populated
     * tree (no pin-on-external-fork behavior).
     * @returns A new DefaultView observing the already-seeded tree.
     */
    const freshViewAfterSeed = (): DefaultView<TestInput, TestOutput, TestProjection, TestMessage> => {
      seedFork();
      return new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
      });
    };

    it('default selection picks the latest sibling Run (fresh view after fork)', () => {
      const v = freshViewAfterSeed();
      expect(v.runs().map((r) => r.runId)).toEqual(['R1', 'R2alt']);
    });

    it('rolls a regenerate group forward to the latest sibling when one appears (live view)', () => {
      // View constructed before any data; watches as R1, R2, R2alt arrive.
      // R2 and R2alt are same-parent reply runs — a regenerate sibling group.
      // Unlike edit (input-node) forks, regenerate groups do NOT pin to the
      // currently-visible member: the slot always rolls forward to the latest
      // (R2alt), so an externally-published regenerator auto-advances the view.
      seedFork();
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2alt']);
    });

    it('selectSibling switches to the chosen sibling Run', () => {
      const v = freshViewAfterSeed();
      v.selectSibling('a1', 0); // anchor a1, older sibling (R2) at index 0
      expect(v.runs().map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('branchSelection().index reflects the chosen sibling', () => {
      const v = freshViewAfterSeed();
      v.selectSibling('a1', 0);
      expect(v.branchSelection('a1').index).toBe(0);
      v.selectSibling('a2', 1);
      expect(v.branchSelection('a2').index).toBe(1);
    });

    it('branchSelection().index returns 0 for an unforked Run', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'x' }, serial: 's1' });
      expect(view.branchSelection('m1').index).toBe(0);
    });

    it('selectSibling clamps the index to the sibling-group bounds', () => {
      const v = freshViewAfterSeed();
      v.selectSibling('a1', 999);
      expect(v.branchSelection('a1').index).toBe(1);
      v.selectSibling('a1', -5);
      expect(v.branchSelection('a1').index).toBe(0);
    });

    it('selectSibling is a no-op when the codec-message-id is not a branch anchor', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'x' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      view.selectSibling('m1', 0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits update when selectSibling changes the visible chain', () => {
      const v = freshViewAfterSeed();
      const handler = vi.fn();
      v.on('update', handler);
      v.selectSibling('a1', 0);
      expect(handler).toHaveBeenCalled();
    });

    it('descendants of the non-selected sibling are hidden', () => {
      const v = freshViewAfterSeed();
      // Descendant of R2 (original branch)
      apply(tree, {
        runId: 'R3orig',
        codecMessageId: 'm-d1',
        parent: 'a1',
        message: { id: 'd', content: 'after-v1' },
        serial: 's4',
      });
      // Descendant of R2alt (the latest branch)
      apply(tree, {
        runId: 'R3alt',
        codecMessageId: 'm-d2',
        parent: 'a2',
        message: { id: 'e', content: 'after-v2' },
        serial: 's5',
      });

      // Default: R2alt is selected (fresh view, no pin yet).
      expect(v.runs().map((r) => r.runId)).toEqual(['R1', 'R2alt', 'R3alt']);
      // Select R2 (anchor a1, index 0): R3orig becomes visible, R3alt hidden.
      v.selectSibling('a1', 0);
      expect(v.runs().map((r) => r.runId)).toEqual(['R1', 'R2', 'R3orig']);
    });
  });

  // -------------------------------------------------------------------------
  // Write operations (send delegate forwarding)
  // -------------------------------------------------------------------------

  describe('write operations', () => {
    it('sendMessage wraps each TMessage via codec.createUserMessage and forwards to delegate', async () => {
      await view.sendMessage({ id: 'a', content: 'hello' });
      expect(sendDelegate).toHaveBeenCalledTimes(1);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const events = call[0];
      expect(events).toHaveLength(1);
      // The View pulls the caller TMessage.id through onto the input's
      // `codecMessageId` so the wire `codec-message-id` matches the
      // local id; the wrapped UserMessage carries the original message.
      expect(events[0]).toMatchObject({
        kind: 'user-message',
        message: { id: 'a', content: 'hello' },
        codecMessageId: 'a',
      });
    });

    it('sendMessage forwards parentCodecMessageId', async () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      await view.sendMessage({ id: 'b', content: 'second' });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      // parentCodecMessageId = last visible message's codec-message-id.
      expect(call[2]).toBe('m1');
    });

    it('sendMessage with empty visible chain passes undefined parentCodecMessageId', async () => {
      await view.sendMessage({ id: 'a', content: 'hi' });
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[2]).toBeUndefined();
    });

    it('sendMessage forwards options through to the delegate', async () => {
      const opts = { runId: 'R-explicit', clientId: 'c-explicit' };
      await view.sendMessage({ id: 'a', content: 'hi' }, opts);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[1]).toBe(opts);
    });

    it('sendMessage uses view-local branch selection as history context', async () => {
      // Build R1 (user) → R2 (assistant) with sibling R2alt at the assistant level.
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
      // Prime the view so the next fork is pinned to R2.
      view.runs();
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });

      // Default visible branch is R2 (pin-on-external-fork). Switch view A
      // to R2alt (anchor a1, index 1) and verify the delegate sees R2alt's
      // projection in history.
      view.selectSibling('a1', 1);
      await view.sendMessage({ id: 'd', content: 'next' });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      // parentCodecMessageId should be a2 (R2alt's reply on the selected branch).
      expect(call[2]).toBe('a2');
    });

    it('sendInput normalises a single TInput', async () => {
      await view.sendInput({ kind: 'user-message', message: { id: 'a', content: 'hi' } });
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual([{ kind: 'user-message', message: { id: 'a', content: 'hi' } }]);
    });

    it('sendInput normalises a TInput[] input', async () => {
      await view.sendInput([
        { kind: 'user-message', message: { id: 'a', content: 'hi' } },
        { kind: 'user-message', message: { id: 'b', content: 'bye' } },
      ]);
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual([
        { kind: 'user-message', message: { id: 'a', content: 'hi' } },
        { kind: 'user-message', message: { id: 'b', content: 'bye' } },
      ]);
    });

    it('sendInput forwards an input with a pinned codecMessageId targeting an existing message', async () => {
      // Inputs whose `codecMessageId` is set target an existing message
      // (continuation tool resolutions, approval responses). The View passes
      // them straight through — the routing field stays on the input itself.
      const input: TestInput[] = [
        { kind: 'user-message', message: { id: 'a', content: 'hi' }, codecMessageId: 'override' },
      ];
      await view.sendInput(input);
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual(input);
    });

    it('regenerate produces a regenerate event keyed on the resolved parent and target codec-message-ids; sendOptions carry parent (no forkOf)', async () => {
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
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });

      // Codec convention: TMessage.id is set to the wire codec-message-id at fold time.
      await view.regenerate('a1');

      expect(sendDelegate).toHaveBeenCalledTimes(1);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const event = call[0][0];
      // The codec's createRegenerate produces the well-known Regenerate
      // variant: `kind: 'regenerate'`, with `target` naming the assistant
      // being regenerated and `parent` naming the user prompt the new
      // assistant threads under.
      expect(event).toEqual({ kind: 'regenerate', target: 'a1', parent: 'u1' });
      // Regenerate sets parent only — the Run-level fork relationship is
      // intentionally absent. The replacement happens at projection
      // extraction time, not via a sibling Run.
      expect(call[1]?.forkOf).toBeUndefined();
      expect(call[1]?.parent).toBe('u1');
    });

    it('regenerate throws when the target message is unknown', async () => {
      await expect(view.regenerate('unknown')).rejects.toThrow(/message not found/);
    });

    it('edit of an already-edited user prompt resolves parent correctly (P1 -> P2 -> P3 chain)', async () => {
      // R1 = [u1, a1] (original).
      // R_edit1 = [u2, a2] (forkOf=u1, the first edit).
      // Now editing u2 should produce a Run that forks u2 (the latest
      // edited prompt). _findParentMsgId for u2 in the visible chain
      // resolves to undefined (u2 is the first visible msg), so the new
      // edit Run is root-level too.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'u1', content: 'alpha' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'a1', content: 'reply-alpha' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R_edit1',
        codecMessageId: 'u2',
        forkOf: 'u1',
        role: 'user',
        message: { id: 'u2', content: 'bravo' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R_edit1',
        codecMessageId: 'a2',
        role: 'assistant',
        parent: 'u2',
        message: { id: 'a2', content: 'reply-bravo' },
        serial: 's4',
      });

      // R_edit1 is the latest auto-selected (per existing pinning rules,
      // but the View pins to the previously-visible R1 unless the caller
      // ran view.edit). To exercise editing u2, select R_edit1 via the
      // user-prompt anchor (u1) at index 1.
      view.selectSibling('u1', 1);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u2', 'a2']);

      await view.edit('u2', { kind: 'user-message', message: { id: 'u3', content: 'charlie' } });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const [, sendOptions] = call;
      // For an edit of the root-level prompt, parent is undefined.
      expect(sendOptions?.parent).toBeUndefined();
      expect(sendOptions?.forkOf).toBe('u2');
    });

    it('edits a run-less input node (the two-node edit target) — resolves kind-blind', async () => {
      // The edit target is a user prompt = a run-LESS INPUT node. Regression
      // guard: edit() must resolve the target via the node union, not the
      // reply-run-only lookup (which returned undefined → "message not found").
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'alpha' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        parent: 'u1',
        message: { id: 'a1', content: 'reply' },
        serial: 's2',
      });

      // Must not throw (the bug threw "message not found in tree").
      await view.edit('u1', { kind: 'user-message', message: { id: 'u1b', content: 'edited' } });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const [, sendOptions] = call;
      expect(sendOptions?.forkOf).toBe('u1');
      expect(sendOptions?.parent).toBeUndefined(); // u1 is the root prompt
    });

    it('regenerate of an already-regenerated assistant resolves parent to the user prompt, not the hidden original assistant', async () => {
      // Setup: R1 = [user u1, asst a1]. Then a regenerate creates R_regen
      // (continuation of R1, regeneratesCodecMessageId=a1, owns a1p). The visible
      // chain after regen = [u1, a1p] (a1 is hidden by message-level
      // replacement).
      //
      // Bug: regenerating a1p (the regenerator's content) used to walk
      // R_regen's projection (idx=0), fall back to the parent Run's tail
      // — which is a1 (the hidden assistant). The history then ended
      // with an assistant message, breaking Anthropic prefill semantics.
      //
      // Expected: parent resolves to u1 (the user prompt the regen is
      // responding to). History sent on send = [u1].
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u1',
        role: 'assistant',
        message: { id: 'a1', content: 'first reply' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R_regen',
        codecMessageId: 'a1p',
        parent: 'u1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'a1p', content: 'regen reply' },
        serial: 's3',
      });

      // Sanity: visible chain after the first regen is [u1, a1p].
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

      await view.regenerate('a1p');

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const [events, sendOptions, parentCodecMessageId] = call;
      // The wire's `parent` must be u1 (the user prompt), NOT a1
      // (the hidden original assistant).
      expect(sendOptions?.parent).toBe('u1');
      expect(parentCodecMessageId).toBe('u1');
      // The regenerate event's anchor codec-message-id must be the CANONICAL
      // anchor (a1), not the clicked-on regen content (a1p). Anchoring
      // every regen at the same canonical codec-message-id grows a single group
      // of alternatives — clicking Regenerate N times produces N+1
      // members at the same branch point.
      const event = events[0];
      // The regenerate input's `target` carries the anchor msg-id; the
      // session reads it directly off the input to stamp
      // `msg-regenerate` on the wire.
      if (!event || !('kind' in event) || event.kind !== 'regenerate') {
        throw new Error('expected regenerate input');
      }
      expect(event.target).toBe('a1');
    });

    it('regenerate throws when the target has no predecessor', async () => {
      apply(tree, { runId: 'R1', codecMessageId: 'only', message: { id: 'x', content: 'x' }, serial: 's1' });
      await expect(view.regenerate('only')).rejects.toThrow(/parent user message not found/);
    });

    it('hides a follow-up turn when its anchor assistant is regenerated mid-conversation', () => {
      // use-chat scenario: user sends "tell me a fact" (R1), gets a1,
      // sends a follow-up "not about honey" parented at a1 (R2 with
      // u2/a2). Then clicks regenerate on a1 — R3 produces a1p.
      // The follow-up R2 lives on the original a1's timeline; it must
      // disappear from the regen branch.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'tell me a fact' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        parent: 'u1',
        message: { id: 'a1', content: 'honey fact' },
        serial: 's2',
      });
      applyInput(tree, {
        codecMessageId: 'u2',
        parent: 'a1',
        message: { id: 'u2', content: 'not about honey' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        parent: 'u2',
        message: { id: 'a2', content: 'ocean fact' },
        serial: 's4',
      });
      // Before regen: full conversation visible.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a1p',
        role: 'assistant',
        parent: 'u1',
        regenerates: 'a1',
        message: { id: 'a1p', content: 'honey fact, take 2' },
        serial: 's5',
      });

      // After regen (latest selected): the follow-up turn (u2 + R2) is hidden —
      // its anchor a1 was substituted by the regenerator.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);
    });

    it('hides Runs parented inside a regen-hidden owner when the original branch is reselected', () => {
      // Tree shape:
      //   R1 owns [u1, a1].
      //   R2 regenerates a1, owns [a1p].
      //   R3 is parented at a1p (lives only on the regen branch) and
      //     owns [u2, a2].
      // Default selection picks R2 (newest regen), so the visible chain
      // is [u1, a1p, u2, a2]. Selecting R1 must collapse the chain to
      // [u1, a1] — R3 belongs to the regen branch and disappears too.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        parent: 'u1',
        message: { id: 'a1', content: 'orig' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1p',
        role: 'assistant',
        parent: 'u1',
        regenerates: 'a1',
        message: { id: 'a1p', content: 'regen' },
        serial: 's3',
      });
      applyInput(tree, { codecMessageId: 'u2', parent: 'a1p', message: { id: 'u2', content: 'q2' }, serial: 's4' });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a2',
        role: 'assistant',
        parent: 'u2',
        message: { id: 'a2', content: 'r2' },
        serial: 's5',
      });

      // Default selection: latest regen (R2) → the follow-up turn chains off it.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'u2', 'a2']);

      // Switch to the original (index 0 in the regen group).
      view.selectSibling('a1', 0);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);

      // Switch back — the regen branch and its follow-up turn reappear.
      view.selectSibling('a1', 1);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'u2', 'a2']);
    });

    it('rolls view.getMessages() forward to a regenerator that lands before the publish ACK resolves', async () => {
      // Race condition repro: the agent publishes ai-run-start for the new
      // regenerator BEFORE the client's publish() ACK returns. A regenerate
      // slot defaults to the latest member (auto-rolls forward), so the view
      // snaps to the newest regenerator the moment it lands — regardless of
      // when the send ACK resolves — unless the user explicitly pinned an
      // earlier one.
      // Two-node model: u1 is a run-less user INPUT node; R1 (reply) parents at
      // it; regenerators are sibling reply runs parented at the same input node.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        parent: 'u1',
        message: { id: 'a1', content: 'orig' },
        serial: 's2',
      });

      // First regen completes — promoted to auto.
      let deferredResolve: ((value: ActiveRun) => void) | undefined;
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'a1',
        runId: Promise.resolve('Rregen1'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'Rregen1', inputEventId: '', sessionName: 'test' }),
      });
      await view.regenerate('a1');
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rregen1',
        clientId: 'agent',
        invocationId: 'inv-1',
        parent: 'u1',
        regenerates: 'a1',
        serial: 's3-start',
      });
      apply(tree, {
        runId: 'Rregen1',
        codecMessageId: 'a1_new1',
        parent: 'u1',
        role: 'assistant',
        regenerates: 'a1',
        message: { id: 'a1_new1', content: 'regen-1' },
        serial: 's3',
      });
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1_new1']);

      // Second regen: ai-run-start arrives BEFORE the publish ACK that
      // resolves sendDelegate, so _applyRegenerateAutoSelect hasn't yet
      // installed the new pending entry.
      vi.mocked(sendDelegate).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- need to capture the resolver
        () =>
          new Promise<ActiveRun>((resolve) => {
            deferredResolve = resolve;
          }),
      );
      const regenPromise = view.regenerate('a1_new1');

      // Agent's lifecycle + output land BEFORE the publish ACK.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rregen2',
        clientId: 'agent',
        invocationId: 'inv-2',
        parent: 'u1',
        regenerates: 'a1',
        serial: 's4-start',
      });
      apply(tree, {
        runId: 'Rregen2',
        codecMessageId: 'a1_new2',
        parent: 'u1',
        role: 'assistant',
        regenerates: 'a1',
        message: { id: 'a1_new2', content: 'regen-2' },
        serial: 's4',
      });
      // Auto-rolls forward to regen-2 the moment its run lands — the slot
      // tracks the latest member; it does not wait for the publish ACK.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1_new2']);

      // The publish ACK resolves later: _applyRegenerateAutoSelect runs and the
      // selection stays on the latest (regen-2).
      deferredResolve?.({
        key: 'a1_new1',
        runId: Promise.resolve('Rregen2'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'Rregen2', inputEventId: '', sessionName: 'test' }),
      });
      await regenPromise;

      // Visible state must now reflect regen-2 — without the recompute
      // in _applyRegenerateAutoSelect, this stays stuck on 'a1_new1'.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1_new2']);
    });

    it('three consecutive regenerates of the same assistant substitute to the latest in view.getMessages()', async () => {
      // Mirror the use-chat demo scenario in the two-node model: a run-less user
      // INPUT node u1, the original reply R1 parented at it, then three
      // sequential regenerates each minting a new reply run parented at the SAME
      // input node (the regenerate sibling group).
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        parent: 'u1',
        message: { id: 'a1', content: 'orig' },
        serial: 's2',
      });

      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);

      // First regenerate.
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'a1',
        runId: Promise.resolve('Rregen1'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'Rregen1', inputEventId: '', sessionName: 'test' }),
      });
      await view.regenerate('a1');
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rregen1',
        clientId: 'agent',
        invocationId: 'inv-1',
        parent: 'u1',
        regenerates: 'a1',
        serial: 's3-start',
      });
      apply(tree, {
        runId: 'Rregen1',
        codecMessageId: 'a1_new1',
        parent: 'u1',
        role: 'assistant',
        regenerates: 'a1',
        message: { id: 'a1_new1', content: 'regen-1' },
        serial: 's3',
      });
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1_new1']);

      // Second regenerate (clicking the displayed regen-1 message).
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'a1_new1',
        runId: Promise.resolve('Rregen2'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'Rregen2', inputEventId: '', sessionName: 'test' }),
      });
      await view.regenerate('a1_new1');
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rregen2',
        clientId: 'agent',
        invocationId: 'inv-2',
        parent: 'u1',
        regenerates: 'a1',
        serial: 's4-start',
      });
      apply(tree, {
        runId: 'Rregen2',
        codecMessageId: 'a1_new2',
        parent: 'u1',
        role: 'assistant',
        regenerates: 'a1',
        message: { id: 'a1_new2', content: 'regen-2' },
        serial: 's4',
      });
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1_new2']);

      // Third regenerate.
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'a1_new2',
        runId: Promise.resolve('Rregen3'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'Rregen3', inputEventId: '', sessionName: 'test' }),
      });
      await view.regenerate('a1_new2');
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rregen3',
        clientId: 'agent',
        invocationId: 'inv-3',
        parent: 'u1',
        regenerates: 'a1',
        serial: 's5-start',
      });
      apply(tree, {
        runId: 'Rregen3',
        codecMessageId: 'a1_new3',
        parent: 'u1',
        role: 'assistant',
        regenerates: 'a1',
        message: { id: 'a1_new3', content: 'regen-3' },
        serial: 's5',
      });
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1_new3']);
    });

    it('edit forwards forkOf and parent for a user-message edit', async () => {
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
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'u2',
        parent: 'a1',
        role: 'user',
        message: { id: 'c', content: 'follow' },
        serial: 's3',
      });

      await view.edit('u2', { kind: 'user-message', message: { id: 'c', content: 'edited' } });
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[1]?.forkOf).toBe('u2');
      expect(call[1]?.parent).toBe('a1'); // predecessor of u2 in flat list
    });

    it('edit throws when the target message is unknown', async () => {
      await expect(view.edit('unknown', { kind: 'user-message', message: { id: 'u', content: 'x' } })).rejects.toThrow(
        /message not found/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Events (scoped to visible)
  // -------------------------------------------------------------------------

  describe('event scoping', () => {
    it('forwards update on tree structural change', () => {
      const handler = vi.fn();
      view.on('update', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalled();
    });

    it('forwards a tree output event as update when the run is on the visible chain', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      // Folding another message into R1 fires the tree 'output' event for a
      // visible run.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'follow' },
        serial: 's2',
      });
      expect(handler).toHaveBeenCalled();
    });

    it('forwards ably-message for a message whose runId is visible', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('ably-message', handler);
      // CAST: tests don't need a fully-typed Ably.InboundMessage.
      const fakeMsg = {
        name: 'fake',
        data: 'x',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R1' } } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(fakeMsg);
      expect(handler).toHaveBeenCalledWith(fakeMsg);
    });

    it('drops ably-message for a message whose runId is NOT visible', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('ably-message', handler);
      const fakeMsg = {
        name: 'fake',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R-other' } } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(fakeMsg);
      expect(handler).not.toHaveBeenCalled();
    });

    it('forwards lifecycle / control ably-messages without a runId or codecMessageId', () => {
      const handler = vi.fn();
      view.on('ably-message', handler);
      const fakeMsg = { name: 'cancel', extras: { ai: { transport: {} } } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(fakeMsg);
      expect(handler).toHaveBeenCalledWith(fakeMsg);
    });

    it('forwards run lifecycle events for visible runs', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('run', handler);
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's2' });
      expect(handler).toHaveBeenCalled();
    });

    it('forwards run-start when parent metadata indicates a visible branch', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('run', handler);
      // Run-start for an unknown new run, but parent points at a visible msg.
      const evt: RunLifecycleEvent = {
        type: 'start',
        runId: 'R2',
        clientId: 'c',
        invocationId: '',
        parent: 'm1',
        serial: 's2',
      };
      // tree.applyRunLifecycle creates R2 with parentCodecMessageId = m1.
      tree.applyRunLifecycle(evt);
      expect(handler).toHaveBeenCalled();
    });

    it('unsubscribe stops forwarding', () => {
      const handler = vi.fn();
      const unsub = view.on('update', handler);
      unsub();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it("messages are recomputed when a visible Run's projection updates", () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      // Fold something into R1.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'follow' },
        serial: 's2',
      });
      expect(view.getMessages()).toEqual([
        { id: 'm1', content: 'q' },
        { id: 'm2', content: 'follow' },
      ]);
      expect(handler).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Reference stability — React change-detection invariant
  // -------------------------------------------------------------------------

  describe('reference stability', () => {
    beforeEach(() => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });
    });

    it('getMessages returns the same array reference across consecutive no-op calls', () => {
      const a = view.getMessages();
      const b = view.getMessages();
      expect(a).toBe(b);
    });

    it('getMessages returns a fresh array reference after a visible Run projection update', () => {
      const before = view.getMessages();
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'follow' },
        serial: 's3',
      });
      const after = view.getMessages();
      expect(after).not.toBe(before);
      // React change-detection: unchanged TMessages keep their reference so
      // memoised components don't re-render.
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it('getMessages keeps its array reference when a continuation projection update arrives but messages are unchanged', () => {
      // Streaming continuation: tree fires the 'output' event for a
      // wire that doesn't alter the visible message list (e.g. amend on a
      // hidden field). The View's `getMessages()` cache stays stable.
      const beforeMessages = view.getMessages();
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'follow' },
        serial: 's3',
      });
      const afterMessages = view.getMessages();
      // Continuation appended a new message; the array is fresh.
      expect(afterMessages).not.toBe(beforeMessages);
    });

    it("suppresses 'update' when projection-updated arrives but projection and messages are unchanged", () => {
      // Custom codec whose fold returns the same projection reference and
      // the same messages array when given a no-op event. This simulates a
      // reducer past its high-water-mark serial (idempotent re-fold).
      const noopCodec = makeTestCodec();
      const sharedMessages = [{ id: 'm1', content: 'q' }];
      const sharedProjection = { messages: sharedMessages };
      noopCodec.fold = (state) => state;
      noopCodec.init = () => sharedProjection;
      noopCodec.getMessages = (p) => p.messages;

      const noopTree = createTree<TestInput, TestOutput, TestProjection>(noopCodec, silentLogger);
      const noopView = new DefaultView({
        tree: noopTree,
        channel: createMockChannel(),
        codec: noopCodec,
        sendDelegate,
        logger: silentLogger,
      });

      apply(noopTree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      noopView.runs(); // prime the cache

      const handler = vi.fn();
      noopView.on('update', handler);
      const beforeCalls = handler.mock.calls.length;

      // Trigger a fold that returns the same projection + same messages.
      noopTree.applyMessage(
        { inputs: [], outputs: [{ type: 'append-message', message: { id: 'x', content: 'noop' } }] },
        {
          [HEADER_RUN_ID]: 'R1',
          [HEADER_CODEC_MESSAGE_ID]: 'm-noop',
        },
      );

      // structural emit on the new codecMessageId index entry is allowed; the
      // output-event path must not double-emit.
      const afterCalls = handler.mock.calls.length;
      // At most one emit (the structural one). The reference-equality
      // short-circuit in _onTreeOutput suppresses the second.
      expect(afterCalls - beforeCalls).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-view co-existence — two views over the same tree
  // -------------------------------------------------------------------------

  describe('multi-view', () => {
    let viewB: DefaultView<TestInput, TestOutput, TestProjection, TestMessage>;

    beforeEach(() => {
      viewB = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
      });
    });

    it('both views receive update when the shared tree changes', () => {
      const aHandler = vi.fn();
      const bHandler = vi.fn();
      view.on('update', aHandler);
      viewB.on('update', bHandler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(aHandler).toHaveBeenCalled();
      expect(bHandler).toHaveBeenCalled();
    });

    it('branch selection is per-view (selecting in one does not affect the other)', () => {
      // Two-node model: u1 is a run-less user INPUT node; R2 is the original
      // reply and R2alt is a regenerator — both parented at u1 (a regenerate
      // sibling group). A regenerate group rolls forward to the latest member,
      // so both views default to R2alt; an explicit per-view selection back to
      // the original (R2) in view A must not affect view B.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'v1' },
        serial: 's2',
      });
      // Prime both views so they see R2 before the regenerator appears.
      view.runs();
      viewB.runs();
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        regenerates: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      expect(view.runs().map((r) => r.runId)).toEqual(['R2alt']);
      expect(viewB.runs().map((r) => r.runId)).toEqual(['R2alt']);

      // Select the original (anchor a1, index 0) in view A; view B is unchanged.
      view.selectSibling('a1', 0);
      expect(view.runs().map((r) => r.runId)).toEqual(['R2']);
      expect(viewB.runs().map((r) => r.runId)).toEqual(['R2alt']);
    });

    it('closing one view does not affect the other', () => {
      const aHandler = vi.fn();
      const bHandler = vi.fn();
      view.on('update', aHandler);
      viewB.on('update', bHandler);

      view.close();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });

      expect(aHandler).not.toHaveBeenCalled();
      expect(bHandler).toHaveBeenCalled();
      // The other view is still functional.
      expect(viewB.runs().map((r) => r.runId)).toEqual(['R1']);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination (loadOlder / hasOlder)
  // -------------------------------------------------------------------------

  describe('loadOlder / hasOlder', () => {
    it('hasOlder is false initially with empty history', async () => {
      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage([]));
      expect(view.hasOlder()).toBe(false);
      await view.loadOlder();
      expect(view.hasOlder()).toBe(false);
    });

    it('loadOlder reveals Runs from history and bumps visible chain', async () => {
      // History returns a single message that creates Run R0.
      const items = [
        {
          message: { id: 'h1', content: 'old' },
          headers: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' },
          serial: 's0',
        },
      ];
      const rawMsg = {
        name: 'fake',
        serial: 's0',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' } } },
      } as unknown as Ably.InboundMessage;

      // The View's _processHistoryPage uses page.rawMessages and decodes
      // them through a fresh codec.createDecoder(). Since our test codec's
      // decoder returns no events, we need to override decode to produce one.
      const decodeSpy = vi.fn(() => ({
        inputs: [],
        outputs: [{ type: 'append-message' as const, message: { id: 'h1', content: 'old' } }],
      }));
      codec.createDecoder = vi.fn(() => ({ decode: decodeSpy }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, [rawMsg]));

      await view.loadOlder(10);
      expect(view.runs().map((r) => r.runId)).toContain('R0');
    });

    it('hasOlder becomes true when history page reports hasNext', async () => {
      const items = [
        {
          message: { id: 'h1', content: 'old' },
          headers: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' },
          serial: 's0',
        },
      ];
      const rawMsg = {
        name: 'fake',
        serial: 's0',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' } } },
      } as unknown as Ably.InboundMessage;
      const decodeSpy = vi.fn(() => ({
        inputs: [],
        outputs: [{ type: 'append-message' as const, message: { id: 'h1', content: 'old' } }],
      }));
      codec.createDecoder = vi.fn(() => ({ decode: decodeSpy }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, [rawMsg], true));

      await view.loadOlder(10);
      expect(view.hasOlder()).toBe(true);
    });

    it('is a no-op when called while already loading', async () => {
      let resolveFirst: ((page: HistoryPage<TestMessage>) => void) | undefined;
      vi.mocked(decodeHistory).mockReturnValueOnce(
        new Promise<HistoryPage<TestMessage>>((resolve) => {
          resolveFirst = resolve;
        }),
      );

      const p1 = view.loadOlder(10);
      const p2 = view.loadOlder(10);
      // Second call should immediately resolve as no-op.
      await p2;
      // decodeHistory called only once.
      expect(vi.mocked(decodeHistory)).toHaveBeenCalledTimes(1);
      resolveFirst?.(makePage([]));
      await p1;
    });

    it('withholds excess Runs and drains them on subsequent loadOlder calls without re-fetching', async () => {
      // First page reveals 3 Runs (R0, R1, R2) on a linear chain (each parented
      // at the prior run's message — two same-parent reply runs would collapse
      // as regenerate siblings in the two-node model). With limit=2 the View
      // reveals the newest 2 and withholds the oldest in the buffer.
      const items = [0, 1, 2].map((i) => ({
        message: { id: `h${String(i)}`, content: `old-${String(i)}` },
        headers: linearChainHeaders(i),
        serial: `s${String(i)}`,
      }));
      const rawMessages = [0, 1, 2].map(
        (i) =>
          ({
            name: 'fake',
            serial: `s${String(i)}`,
            extras: { ai: { transport: linearChainHeaders(i) } },
          }) as unknown as Ably.InboundMessage,
      );
      codec.createDecoder = vi.fn(() => ({
        decode: (msg: Ably.InboundMessage) => {
          const id =
            (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport[HEADER_CODEC_MESSAGE_ID] ??
            'unknown';
          return {
            inputs: [],
            outputs: [{ type: 'append-message' as const, message: { id, content: 'x' } }],
          };
        },
      }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, rawMessages));

      await view.loadOlder(2);
      // The newest 2 by startSerial (R1, R2) are revealed; R0 is withheld.
      expect(
        view
          .runs()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R1', 'R2']);
      expect(view.hasOlder()).toBe(true);

      // Second loadOlder drains the withheld buffer (R0). decodeHistory is
      // NOT called again — the buffer drain path returns without fetching.
      await view.loadOlder(2);
      expect(
        view
          .runs()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R0', 'R1', 'R2']);
      expect(vi.mocked(decodeHistory)).toHaveBeenCalledTimes(1);
    });

    it('suppresses ably-message events for withheld Runs', async () => {
      // Linear chain so all three runs stay visible (same-parent reply runs
      // would collapse as regenerate siblings in the two-node model).
      const items = [0, 1, 2].map((i) => ({
        message: { id: `h${String(i)}`, content: `old-${String(i)}` },
        headers: linearChainHeaders(i),
        serial: `s${String(i)}`,
      }));
      const rawMessages = items.map(
        (it) =>
          ({
            name: 'fake',
            serial: it.serial,
            extras: { ai: { transport: it.headers } },
          }) as unknown as Ably.InboundMessage,
      );
      codec.createDecoder = vi.fn(() => ({
        decode: (msg: Ably.InboundMessage) => {
          const id =
            (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport[HEADER_CODEC_MESSAGE_ID] ??
            'unknown';
          return {
            inputs: [],
            outputs: [{ type: 'append-message' as const, message: { id, content: 'x' } }],
          };
        },
      }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, rawMessages));
      await view.loadOlder(2);

      // R0 is withheld at this point. An ably-message for R0 must be
      // suppressed; an ably-message for R1 (visible) must pass through.
      const handler = vi.fn();
      view.on('ably-message', handler);

      const withheldMsg = {
        name: 'fake',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R0' } } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(withheldMsg);
      expect(handler).not.toHaveBeenCalled();

      const visibleMsg = {
        name: 'fake',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R1' } } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(visibleMsg);
      expect(handler).toHaveBeenCalledWith(visibleMsg);
    });

    // ---------------------------------------------------------------------
    // Pagination edge cases (AIT-773 §7.6)
    // ---------------------------------------------------------------------

    it('handles a Run that spans multiple channel pages by carrying state across decodeHistory.next()', async () => {
      // Simulate a Run R-multi whose messages appear across two channel
      // pages: page1 has the first wire, page2 (via .next()) has the
      // second wire. The Tree folds both into the same RunNode.
      const headersA = { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-multi-a' };
      const headersB = { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-multi-b' };
      const rawA = {
        name: 'fake',
        serial: 's01',
        extras: { ai: { transport: headersA } },
      } as unknown as Ably.InboundMessage;
      const rawB = {
        name: 'fake',
        serial: 's02',
        extras: { ai: { transport: headersB } },
      } as unknown as Ably.InboundMessage;

      codec.createDecoder = vi.fn(() => ({
        decode: (msg: Ably.InboundMessage) => {
          const id =
            (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport[HEADER_CODEC_MESSAGE_ID] ?? '?';
          return {
            inputs: [],
            outputs: [{ type: 'append-message' as const, message: { id, content: id } }],
          };
        },
      }));

      const page2 = makePage(
        [{ message: { id: 'm-multi-b', content: 'multi-b' }, headers: headersB, serial: 's02' }],
        [rawB],
      );
      const page1 = makePage(
        [{ message: { id: 'm-multi-a', content: 'multi-a' }, headers: headersA, serial: 's01' }],
        [rawA],
        true,
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        async () => page2,
      );
      vi.mocked(decodeHistory).mockResolvedValueOnce(page1);

      await view.loadOlder(2);

      // The single Run R-multi materialised from both pages; both messages
      // belong to one RunNode.
      const nodes = view.runs();
      expect(nodes.map((n) => n.runId)).toEqual(['R-multi']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['m-multi-a', 'm-multi-b']);
    });

    it('includes a Run with zero codec-fold output in the visible chain but contributes no messages to getMessages', async () => {
      // History contains an ai-run-start with no subsequent content wires
      // (rare; can happen if the agent crashed before publishing any chunk).
      // The View flattens the Run but getMessages produces nothing for it.
      const runStartMsg = {
        name: EVENT_RUN_START,
        serial: 's01',
        extras: {
          ai: {
            transport: {
              [HEADER_RUN_ID]: 'R-empty',
              'run-client-id': '',
            },
          },
        },
      } as unknown as Ably.InboundMessage;

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage([], [runStartMsg]));

      await view.loadOlder(1);

      const nodes = view.runs();
      expect(nodes.map((n) => n.runId)).toEqual(['R-empty']);
      expect(view.getMessages()).toEqual([]);
    });

    it('reconstructs a suspended run from history (run-suspend marks the run suspended)', async () => {
      // A run that suspended in the past appears in history as a run-start
      // followed by an ai-run-suspend (no run-end). History replay must
      // rebuild the Run and mark it suspended — not active, not ended.
      const runStartMsg = {
        name: EVENT_RUN_START,
        serial: 's01',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R-susp', 'run-client-id': '' } } },
      } as unknown as Ably.InboundMessage;
      const runSuspendMsg = {
        name: EVENT_RUN_SUSPEND,
        serial: 's02',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R-susp', 'run-client-id': '' } } },
      } as unknown as Ably.InboundMessage;

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage([], [runStartMsg, runSuspendMsg]));

      await view.loadOlder(1);

      const node = view.runs().find((n) => n.runId === 'R-susp');
      expect(node?.status).toBe('suspended');
    });

    it('reconstructs a resumed run from history (run-resume re-activates it)', async () => {
      // A run that suspended and then resumed in the past appears in history as
      // run-start → ai-run-suspend → ai-run-resume. History replay must rebuild
      // the Run and leave it active after the resume.
      const transport = { [HEADER_RUN_ID]: 'R-resumed', 'run-client-id': '' };
      const lifecycle = (name: string, serial: string): Ably.InboundMessage =>
        ({ name, serial, extras: { ai: { transport } } }) as unknown as Ably.InboundMessage;

      vi.mocked(decodeHistory).mockResolvedValueOnce(
        makePage(
          [],
          [lifecycle(EVENT_RUN_START, 's01'), lifecycle(EVENT_RUN_SUSPEND, 's02'), lifecycle(EVENT_RUN_RESUME, 's03')],
        ),
      );

      await view.loadOlder(1);

      const node = view.runs().find((n) => n.runId === 'R-resumed');
      expect(node?.status).toBe('active');
    });
  });

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('stops forwarding events after close', () => {
      const handler = vi.fn();
      view.on('update', handler);
      view.close();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('invokes onClose hook', () => {
      const onClose = vi.fn();
      const v = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
        onClose,
      });
      v.close();
      expect(onClose).toHaveBeenCalled();
    });

    it('makes sendInput reject with InvalidArgument after close', async () => {
      view.close();
      await expect(view.sendInput({ kind: 'user-message', message: { id: 'a', content: 'hi' } })).rejects.toThrow(
        /view is closed/,
      );
    });

    it('makes regenerate reject after close', async () => {
      view.close();
      await expect(view.regenerate('any')).rejects.toThrow(/view is closed/);
    });

    it('makes edit reject after close', async () => {
      view.close();
      await expect(view.edit('any', { kind: 'user-message', message: { id: 'a', content: 'x' } })).rejects.toThrow(
        /view is closed/,
      );
    });

    it('is idempotent: double close does not throw and onClose fires once', () => {
      const onClose = vi.fn();
      const v = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
        onClose,
      });
      v.close();
      expect(() => {
        v.close();
      }).not.toThrow();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('loadOlder after close is a no-op (no decodeHistory call)', async () => {
      view.close();
      await view.loadOlder(10);
      expect(vi.mocked(decodeHistory)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Branch auto-select / pending after fork operations
  // -------------------------------------------------------------------------

  describe('branch auto-select after fork', () => {
    beforeEach(() => {
      // role omitted so the user-content wire keeps routing at wire-runId
      // (the role-based sub-Run split is exercised elsewhere). These tests
      // focus on pending / auto-select sibling state after fork operations.
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });
    });

    it('regenerate sets a pending regenerate selection that resolves when the new Run arrives', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'a1',
        runId: Promise.resolve('R2new'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'R2new', inputEventId: '', sessionName: 'test' }),
      });

      await view.regenerate('a1');
      // Pending selection is recorded but the new Run hasn't arrived yet;
      // the chain is unchanged (R1 + R2).
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2']);

      // Now the new continuation Run arrives — regenerates the assistant
      // in R2 (anchored at codec-message-id a1), parented under R2 (the prior Run).
      apply(tree, {
        runId: 'R2new',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        message: { id: 'c', content: 'new-reply' },
        serial: 's3',
      });

      // Pending selection promotes to `auto`. The visible chain now
      // includes R2new (the regenerator) and the message-level replacement
      // hides the original assistant 'a1' from R2 at extraction time.
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2', 'R2new']);
    });

    it('pending selection is cleared on run-end when the server never creates the sibling Run', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'a1',
        runId: Promise.resolve('R2new'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'R2new', inputEventId: '', sessionName: 'test' }),
      });

      await view.regenerate('a1');
      // Pending selection is in place; visible chain still shows R2 (only sibling).
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2']);

      // Server errors out: run-end arrives for the original prompt's runId
      // without a sibling Run being created.
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R2new',
        clientId: 'c',
        invocationId: '',
        reason: 'error',
        serial: 's3',
      });

      // Now an external regenerator appears (a sibling reply run at the same
      // input prompt u1). A regenerate group rolls forward to the latest member,
      // so the slot adopts R2-late.
      apply(tree, {
        runId: 'R2-late',
        codecMessageId: 'a-late',
        parent: 'u1',
        regenerates: 'a1',
        message: { id: 'c', content: 'late' },
        serial: 's4',
      });

      // The regenerate group rolls to the latest sibling (R2-late). The key
      // invariant under test is that the cleared pending state did not survive
      // and incorrectly latch the view onto the original.
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2-late']);
    });

    it('preserves an explicit `user` branch selection when an external fork lands later', () => {
      // The outer beforeEach already seeded R1 + R2. Add a first external
      // fork (R2alt) so the user has a sibling group to choose in, then
      // assert their explicit selection survives a second external fork.
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a-alt-1',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'alt-1' },
        serial: 's3',
      });
      // User explicitly selects R2 (the original) via the a1 anchor.
      view.selectSibling('a1', 0);
      expect(view.runs().map((n) => n.runId)).toEqual(['R1', 'R2']);

      // Another external fork lands.
      apply(tree, {
        runId: 'R2alt-2',
        codecMessageId: 'a-alt-2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'd', content: 'alt-2' },
        serial: 's4',
      });

      // The user's `kind: 'user'` selection survives the external-fork
      // pinning pass; we should still see R2, not the newer sibling.
      expect(view.runs().map((n) => n.runId)).toEqual(['R1', 'R2']);
    });

    it('keeps an explicit regen selection when another external regen lands afterwards', () => {
      // R1 + R2 already exist (the assistant a1 is in R2 per the
      // describe-block beforeEach). Add a regenerator targeting a1, then
      // verify a user selection back to the original survives a second
      // external regen.
      apply(tree, {
        runId: 'R_regen1',
        codecMessageId: 'a1p',
        parent: 'u1',
        regenerates: 'a1',
        message: { id: 'a1p', content: 'regen' },
        serial: 's3',
      });
      // User explicitly switches to the ORIGINAL alternative (a1 in R2).
      // The codec rebinds TMessage.id to the wire codec-message-id, so the visible
      // ids match the apply()'d codecMessageIds.
      view.selectSibling('a1p', 0);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);

      // Another participant publishes a second regenerator at the same
      // canonical anchor (sibling reply run under the same input prompt).
      apply(tree, {
        runId: 'R_regen2',
        codecMessageId: 'a1pp',
        parent: 'u1',
        regenerates: 'a1',
        message: { id: 'a1pp', content: 'regen-2' },
        serial: 's4',
      });

      // The user's explicit choice survives: visible content is still the
      // original assistant, not either regenerator.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
    });

    it('edit auto-selects the new sibling Run from optimisticCodecMessageIds', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        key: 'u-new',
        runId: Promise.resolve('R2edit'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: ['u-new'],
        inputEventId: '',
        toInvocation: () => Invocation.fromJSON({ runId: 'R2edit', inputEventId: '', sessionName: 'test' }),
      });
      // For the auto-select to land, the new Run needs to exist in the tree.
      // role omitted so the new user-content wire routes at wire-runId.
      apply(tree, {
        runId: 'R2edit',
        codecMessageId: 'u-new',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'edited' },
        serial: 's3',
      });
      await view.edit('a1', { kind: 'user-message', message: { id: 'c', content: 'edited' } });

      // Auto-select kicks in immediately after the delegate returns.
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2edit']);
    });
  });

  // -------------------------------------------------------------------------
  // Regenerate-as-continuation: message-level replacement and branch nav
  // -------------------------------------------------------------------------

  describe('regenerate-as-continuation', () => {
    // Two-node model: U1 is a run-less user INPUT node. R1 is the original
    // reply RUN parented at U1; R2 is the regenerator reply RUN parented at the
    // SAME input node (same-parent reply runs are the regenerate sibling group).
    // The two replies collapse to the selected member; the View shows the input
    // prompt (from the input node) plus the selected reply's content.
    beforeEach(() => {
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u1',
        role: 'assistant',
        message: { id: 'a1', content: 'reply' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'u1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'a2', content: 'regen' },
        serial: 's3',
      });
    });

    it('default visible chain hides the regenerated message and shows the regenerator content', () => {
      // The regenerate group collapses to the latest reply run (R2); the
      // original reply R1 is hidden. The user prompt comes from the input node.
      expect(view.runs().map((r) => r.runId)).toEqual(['R2']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a2']);
    });

    it('branchSelection().index defaults to the latest regenerator', () => {
      expect(view.branchSelection('a1').index).toBe(1);
    });

    it('selectSibling(anchor, 0) switches the regenerate group to the original — projection extraction shows the original assistant', () => {
      view.selectSibling('a1', 0);
      expect(view.runs().map((r) => r.runId)).toEqual(['R1']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
      expect(view.branchSelection('a1').index).toBe(0);
    });

    it('selectSibling(anchor, 1) restores the regenerator selection', () => {
      view.selectSibling('a1', 0);
      view.selectSibling('a1', 1);
      expect(view.runs().map((r) => r.runId)).toEqual(['R2']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a2']);
    });
  });

  // -------------------------------------------------------------------------
  // Msg-anchored branch-point API (AITRFC-014 — branch points are anchored
  // at codec-message-ids; the View surfaces per-bubble nav rather than per-Run nav so
  // arrows attach only to the actual anchor message).
  // -------------------------------------------------------------------------

  describe('msg-anchored branch nav', () => {
    describe('regenerate', () => {
      beforeEach(() => {
        // Two-node model: u1 is a run-less user INPUT node; R1 is the original
        // reply parented at it; R2 is the regenerator reply parented at the SAME
        // input node (same-parent reply runs form the regenerate group).
        applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'first' }, serial: 's1' });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          parent: 'u1',
          role: 'assistant',
          message: { id: 'a1', content: 'reply' },
          serial: 's2',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2',
          parent: 'u1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a2', content: 'regen' },
          serial: 's3',
        });
      });

      it('branchSelection().hasSiblings is false for the user prompt codec-message-id (not an anchor)', () => {
        expect(view.branchSelection('u1').hasSiblings).toBe(false);
      });

      it('branchSelection().hasSiblings is true for the regen anchor codec-message-id', () => {
        expect(view.branchSelection('a1').hasSiblings).toBe(true);
      });

      it('branchSelection().hasSiblings is true for a regenerator Run content codec-message-id', () => {
        expect(view.branchSelection('a2').hasSiblings).toBe(true);
      });

      it('branchSelection().siblings returns the resolved regen variants at an anchor codec-message-id', () => {
        expect(view.branchSelection('a1').siblings.map((m) => m.id)).toEqual(['a1', 'a2']);
        expect(view.branchSelection('a2').siblings.map((m) => m.id)).toEqual(['a1', 'a2']);
      });

      it('branchSelection returns the singleton message for a known non-anchor codec-message-id', () => {
        // The bundle always contains the rendered message itself for known
        // ids, so plain bubbles get `siblings.length === 1`.
        const branch = view.branchSelection('u1');
        expect(branch.hasSiblings).toBe(false);
        expect(branch.siblings.map((m) => m.id)).toEqual(['u1']);
      });

      it('selectSibling on the anchor codec-message-id switches the regen selection', () => {
        view.selectSibling('a2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
        view.selectSibling('a1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a2']);
      });

      it('selectSibling on a non-anchor codec-message-id is a no-op', () => {
        const before = view.getMessages().map((m) => m.id);
        view.selectSibling('u1', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(before);
      });
    });

    // -----------------------------------------------------------------------
    // Regenerate with trailing follow-up messages in the same Run
    // -----------------------------------------------------------------------
    //
    // The original assistant Run holds two messages: the tool-call
    // bubble (a1, the regenerate target) followed by the LLM text
    // bubble (a2) that the model wrote after the tool result was
    // folded in. Regenerating a1 means the agent will re-do the tool
    // call AND its follow-up; the entire trail from a1 onwards in R1
    // is conceptually replaced by R2's projection, even though only
    // a1 is named as the regenerate anchor.
    describe('regenerate with trailing messages in the same Run', () => {
      beforeEach(() => {
        // u1 is a run-less input node; R1 (the original reply) holds two
        // assistant bubbles and parents at u1.
        applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q' }, serial: 's1' });
        // a1 — tool-call bubble (the regenerate target).
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          parent: 'u1',
          role: 'assistant',
          message: { id: 'a1', content: 'tool-call' },
          serial: 's2',
        });
        // a2 — follow-up text bubble inside the same Run.
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a2',
          role: 'assistant',
          message: { id: 'a2', content: 'follow-up' },
          serial: 's3',
        });
        // R2 regenerates a1, parented at the SAME input node u1. Its projection
        // contains a1' (new tool call) and a2' (its follow-up text).
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a1p',
          parent: 'u1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a1p', content: 'new-tool-call' },
          serial: 's4',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2p',
          role: 'assistant',
          message: { id: 'a2p', content: 'new-follow-up' },
          serial: 's5',
        });
      });

      it('hides both the regenerated message AND its trailing follow-ups in the owner Run', () => {
        // a2 in R1 must be hidden too: it was generated AFTER a1 and is
        // semantically part of the same "turn" as the regenerated tool
        // call. Pre-fix it stayed visible, producing a 3-bubble chat
        // (a2 + a1' + a2') instead of the expected 2-bubble layout.
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'a2p']);
      });

      it('only the position-equivalent message in each variant is a branch point', () => {
        // Anchor (a1) and its position-equivalent (a1p, the first
        // message of R2) are branch points — clicking arrows on those
        // bubbles flips the variant. Trailing messages (a2 in the
        // original; a2p in the regenerator) are not branch anchors and
        // should not surface navigation arrows.
        expect(view.branchSelection('a1').hasSiblings).toBe(true);
        expect(view.branchSelection('a1p').hasSiblings).toBe(true);
        expect(view.branchSelection('a2').hasSiblings).toBe(false);
        expect(view.branchSelection('a2p').hasSiblings).toBe(false);
      });

      it('branchSelection().siblings on the anchor returns the head message of each variant', () => {
        expect(view.branchSelection('a1').siblings.map((m) => m.id)).toEqual(['a1', 'a1p']);
        expect(view.branchSelection('a1p').siblings.map((m) => m.id)).toEqual(['a1', 'a1p']);
      });

      it('selectSibling on the anchor swaps the entire regenerated trail', () => {
        // Selecting back to the original (index 0) restores BOTH a1 and a2 in R1.
        view.selectSibling('a1', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1', 'a2']);
        // Selecting back to the regenerator (index 1) hides them again.
        view.selectSibling('a1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'a2p']);
      });
    });

    // -----------------------------------------------------------------------
    // Nested regenerate: trailing message inside a regenerator Run
    // -----------------------------------------------------------------------
    //
    // After regenerating a1 (R2 holds [a1p, a2p]) the user clicks
    // Regenerate on a2p. Pre-fix this rebased the anchor to a1 (the
    // group root) and produced a new full-conversation Run that joined
    // the a1 group as a third member — the chat showed one "combined"
    // bubble with "3 / 3" navigation. The user expects a local regen
    // of the trailing text: a new Run anchored at a2p, contributing a
    // single new text bubble while a1p stays put with its 2/2 counter.
    describe('regenerate target inside a regenerator Run', () => {
      let regen2: ActiveRun;
      beforeEach(async () => {
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
          message: { id: 'a1', content: 'tc-original' },
          serial: 's2',
        });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a2',
          role: 'assistant',
          message: { id: 'a2', content: 'tt-original' },
          serial: 's3',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a1p',
          parent: 'a1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a1p', content: 'tc-regen' },
          serial: 's4',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2p',
          role: 'assistant',
          message: { id: 'a2p', content: 'tt-regen' },
          serial: 's5',
        });
        regen2 = await view.regenerate('a2p');
      });

      it('mints a regenerate event anchored at the trailing msg-id (not at the group root)', () => {
        // CAST: vi.fn returns a MockInstance that the codebase types via `SendDelegate`.
        const mocked = sendDelegate as unknown as Mock<SendDelegate<TestInput>>;
        const lastCall = mocked.mock.calls.at(-1);
        const events = lastCall?.[0];
        const event = events?.[0];
        // The codec's createRegenerate puts the regen target in `target` and
        // the parent user prompt in `parent`.
        expect(event).toEqual({ kind: 'regenerate', target: 'a2p', parent: 'a1p' });
        // The new Run joins a fresh group anchored at a2p, not the a1 group.
        expect(regen2).toBeDefined();
      });

      // TODO(AIT-831): deferred — intra-run mid-reply regenerate (slicing inside
      // a multi-message run projection). Re-enable with the regenerate-of-
      // multi-message golden test (see pr2-execution-plan.md §Tests).
      it.skip('a fully-folded trailing regen contributes only the new trailing message; the tool-call bubble stays put', () => {
        apply(tree, {
          runId: 'R3',
          codecMessageId: 'a2pp',
          parent: 'a1p',
          regenerates: 'a2p',
          role: 'assistant',
          message: { id: 'a2pp', content: 'tt-regen-2' },
          serial: 's6',
        });
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'a2pp']);
        // Tool-call bubble: still navigates the a1 group (2/2).
        expect(view.branchSelection('a1p').hasSiblings).toBe(true);
        expect(view.branchSelection('a1p').siblings.map((m) => m.id)).toEqual(['a1', 'a1p']);
        // Trailing bubble: navigates the a2p group (2/2), distinct from the a1 group.
        expect(view.branchSelection('a2pp').hasSiblings).toBe(true);
        expect(view.branchSelection('a2pp').siblings.map((m) => m.id)).toEqual(['a2p', 'a2pp']);
      });
    });

    // -----------------------------------------------------------------------
    // Multiple regen groups inside the same owner Run
    // -----------------------------------------------------------------------
    //
    // After regenerating the trailing text (R2 regenerates a2 in R1)
    // and then regenerating the tool-call (R3 regenerates a1 in R1),
    // R3's truncation of R1 at a1 also invalidates a2 — and with it
    // the a2 regen group's regenerator R2. Pre-fix R2 stayed visible
    // and leaked its content between u1 and R3's payload, producing a
    // 3-bubble chat (R2's regen + R3's pair). The view must shadow R2.
    describe('multiple regen anchors in the same owner Run', () => {
      beforeEach(() => {
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
          message: { id: 'a1', content: 'tc-original' },
          serial: 's2',
        });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a2',
          role: 'assistant',
          message: { id: 'a2', content: 'tt-original' },
          serial: 's3',
        });
        // Trailing-text regen lands first (R2 anchored at a2).
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2p',
          parent: 'a1',
          regenerates: 'a2',
          role: 'assistant',
          message: { id: 'a2p', content: 'tt-regen' },
          serial: 's4',
        });
        // Tool-call regen lands next (R3 anchored at a1) — it covers an
        // earlier position in R1's projection than R2.
        apply(tree, {
          runId: 'R3',
          codecMessageId: 'a1p',
          parent: 'u1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a1p', content: 'tc-regen' },
          serial: 's5',
        });
        apply(tree, {
          runId: 'R3',
          codecMessageId: 'a2pp',
          role: 'assistant',
          message: { id: 'a2pp', content: 'tt-fresh' },
          serial: 's6',
        });
      });

      // TODO(AIT-831): deferred — intra-run mid-reply regenerate (multiple regen
      // anchors inside one multi-message run projection). Re-enable with the
      // regenerate-of-multi-message golden test (see pr2-execution-plan.md §Tests).
      it.skip('hides the trailing-text regenerator when an earlier regen covers its anchor in the same owner Run', () => {
        // Visible chain: u1 from R1 (truncated at a1), then R3's pair.
        // R2 (the trailing-text regenerator) is shadowed.
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p', 'a2pp']);
      });

      // TODO(AIT-831): deferred — intra-run mid-reply regenerate selection.
      // Re-enable with the regenerate-of-multi-message golden test.
      it.skip('selecting back to the original at the tool-call anchor reactivates the trailing-text regenerator', () => {
        // Navigate from R3 back to R1 at the a1 anchor. R3 no longer
        // truncates R1, so R2's anchor (a2) is back in the visible
        // chain and R2's content surfaces.
        view.selectSibling('a1', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1', 'a2p']);
        expect(view.branchSelection('a2p').hasSiblings).toBe(true);
        expect(view.branchSelection('a2p').siblings.map((m) => m.id)).toEqual(['a2', 'a2p']);
      });
    });

    describe('edit', () => {
      beforeEach(() => {
        // Original Run R1: user prompt + assistant.
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'u1',
          role: 'user',
          message: { id: 'u1', content: 'alpha' },
          serial: 's1',
        });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          role: 'assistant',
          message: { id: 'a1', content: 'reply-alpha' },
          serial: 's2',
        });
        // Edited Run R2: forkOf the original user prompt, new user msg + asst.
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'u2',
          forkOf: 'u1',
          role: 'user',
          message: { id: 'u2', content: 'bravo' },
          serial: 's3',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2',
          role: 'assistant',
          parent: 'u2',
          message: { id: 'a2', content: 'reply-bravo' },
          serial: 's4',
        });
      });

      it('branchSelection().hasSiblings is true for the user prompt codec-message-id (edit anchor)', () => {
        expect(view.branchSelection('u2').hasSiblings).toBe(true);
      });

      it('branchSelection().hasSiblings is false for the assistant codec-message-id (not an edit anchor)', () => {
        expect(view.branchSelection('a2').hasSiblings).toBe(false);
      });

      it('branchSelection().siblings returns each sibling user-prompt at the edit anchor', () => {
        expect(view.branchSelection('u2').siblings.map((m) => m.id)).toEqual(['u1', 'u2']);
      });

      it('selectSibling on the user-prompt anchor swaps the whole Run', () => {
        // Explicitly select R2 first (the edited branch) so the swap to
        // R1 via the anchor is observable independent of the default
        // pinning behaviour.
        view.selectSibling('u2', 1);
        view.selectSibling('u2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
      });

      it('selectSibling on the assistant codec-message-id is a no-op (assistant is not the edit anchor)', () => {
        const before = view.getMessages().map((m) => m.id);
        view.selectSibling('a2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(before);
      });
    });

    // ---------------------------------------------------------------------
    // Coexisting edit fork-of AND regenerate groups on the same Run
    // ---------------------------------------------------------------------
    //
    // Scenario: a Run R1 owns both a user prompt (which got edited into a
    // sibling Run R_edit) and an assistant message (which got regenerated
    // into a continuation Run R_regen). R1 is simultaneously in a
    // fork-of sibling group (vs R_edit at the parent's children level)
    // AND in a regenerate sibling group (vs R_regen at the assistant
    // codec-message-id level).
    //
    // Branch nav on R1's assistant must navigate the REGEN group; nav on
    // R1's user prompt must navigate the FORK-OF group. The runId alone
    // is ambiguous — the codec-message-id is the disambiguator.

    describe('regenerate then edit (R1 in both groups)', () => {
      beforeEach(() => {
        // Two-node model: u1 is a run-less user INPUT node; the original reply
        // R1 parents at it. The user prompt and assistant reply are now distinct
        // nodes — the edit forks the INPUT node, the regenerate groups the REPLY
        // runs, so the two branch groups are cleanly kind-separated.
        applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'first' }, serial: 's1' });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          parent: 'u1',
          role: 'assistant',
          message: { id: 'a1', content: 'reply' },
          serial: 's2',
        });
        // Regenerate produces R_regen — a sibling reply run parented at the same
        // input node u1, regenerating a1.
        apply(tree, {
          runId: 'R_regen',
          codecMessageId: 'a1p',
          parent: 'u1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a1p', content: 'reply-prime' },
          serial: 's3',
        });
        // Edit produces a sibling INPUT node u2 (forkOf u1); its reply R_edit
        // parents at u2.
        applyInput(tree, {
          codecMessageId: 'u2',
          forkOf: 'u1',
          message: { id: 'u2', content: 'edited' },
          serial: 's4',
        });
        apply(tree, {
          runId: 'R_edit',
          codecMessageId: 'a2',
          role: 'assistant',
          parent: 'u2',
          message: { id: 'a2', content: 'reply-edited' },
          serial: 's5',
        });
        // Pin to the original prompt u1 in the fork-of group (anchor u1, index 0)
        // so the regen nav is exercisable on the visible chain.
        view.selectSibling('u1', 0);
      });

      it('branchSelection().hasSiblings disambiguates by codec-message-id: user prompt anchors fork-of, assistant anchors regen', () => {
        // user prompt u1 is the fork-of anchor (first msg of R1).
        expect(view.branchSelection('u1').hasSiblings).toBe(true);
        // assistant a1 is the regen anchor.
        expect(view.branchSelection('a1').hasSiblings).toBe(true);
      });

      it('selectSibling on the assistant codec-message-id navigates the REGEN group, not the fork-of group', () => {
        // Start: visible chain shows [P1, R1'] (R1 selected, regen R_regen latest).
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

        // Click `<` on the asst bubble — go to the original R1's asst.
        view.selectSibling('a1p', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);

        // Click `>` on the asst bubble — should return to R1' (the regen).
        // BUG: this currently switches the fork-of selection to R_edit
        // and ends up on [u2, a2] instead of [u1, a1p].
        view.selectSibling('a1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);
      });

      it('selectSibling on the user-prompt codec-message-id navigates the FORK-OF group', () => {
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

        // Click `>` on the user bubble — switch to the edited branch.
        view.selectSibling('u1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u2', 'a2']);

        // Click `<` to come back.
        view.selectSibling('u2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);
      });

      it('branchSelection().index reports the correct group selection for each codec-message-id', () => {
        // Initial state: fork-of selection = R1 (index 0); regen selection
        // = R_regen (auto, no explicit selection → defaults to latest, index 1).
        expect(view.branchSelection('u1').index).toBe(0);
        expect(view.branchSelection('a1p').index).toBe(1);
      });
    });
  });
});
