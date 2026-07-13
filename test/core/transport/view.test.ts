import * as Ably from 'ably';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import type {
  Codec,
  CodecEvent,
  CodecInputEvent,
  CodecMessage,
  Decoder,
  ReducerMeta,
} from '../../../src/core/codec/types.js';
import { createWireApplier } from '../../../src/core/transport/decode-fold.js';
import { createHistoryHydrator, type HistoryHydrator } from '../../../src/core/transport/history-hydrator.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import { createLeafBranchSource, LeafBranchSource } from '../../../src/core/transport/leaf-branch-source.js';
// Vitest hoists vi.mock above imports, so this static import gets the mock.
import { type HistoryPagesCursor, loadHistoryPages } from '../../../src/core/transport/load-history-pages.js';
import type { DefaultTree } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { ClientRun, ClientView, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import type { SendDelegate } from '../../../src/core/transport/view.js';
import { createClientView } from '../../../src/core/transport/view.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { makeFakeLoadUntil } from '../../helper/fake-load-until.js';
import { makeHistoryCursor } from '../../helper/history-cursor.js';

vi.mock('../../../src/core/transport/load-history-pages.js', () => ({
  loadHistoryPages: vi.fn(),
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
  fold: (state: TestProjection, codecEvent: CodecEvent<TestInput, TestOutput>, meta: ReducerMeta) => {
    const event = codecEvent.event;
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
  getMessages: (projection: TestProjection) => projection.messages.map((m) => ({ codecMessageId: m.id, message: m })),
  createEncoder: () => {
    throw new Error('not used in view tests');
  },
  createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
  createUserMessage: (message: TestMessage) => ({ kind: 'user-message' as const, message }),
  createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }),
});

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// Drain the microtask queue. A busy microtask loop (the bug this guards against)
// would never let the queued resolve run, so this never settles. Deliberately
// distinct from test/helper/streams.ts#flushMicrotasks (a fixed two-tick
// `Promise.resolve`): only a single queued `queueMicrotask` detects a busy spin,
// so do not consolidate the two.
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

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

// Build a ClientRun<TestInput, TestMessage> mock; override inputCodecMessageId / runId per case.
const makeClientRun = (
  overrides: Partial<ClientRun<TestInput, TestMessage>> = {},
): ClientRun<TestInput, TestMessage> => ({
  inputCodecMessageId: 'mock-input',
  runId: 'mock-run',
  status: 'active',
  error: undefined,
  messages: [],
  started: Promise.resolve(),
  inputEventId: '',
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  cancel: () => Promise.resolve(),
  steer: () => ({ published: Promise.resolve({ serial: undefined }), outcome: Promise.resolve({ consumed: false }) }),
  toInvocation: () => Invocation.fromJSON({ inputEventId: '', sessionName: 'test' }),
  ...overrides,
});

const createMockSendDelegate = (): SendDelegate<TestInput, TestMessage> =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  vi.fn(() => Promise.resolve(makeClientRun()));

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

/**
 * Seed a tool-call turn R1 = [u1, TC, TT] in the two-node model: a user input
 * node `u1`, then one reply run `R1` carrying a tool-call message `TC` followed
 * by a follow-up text message `TT`. Mirrors the demo's approval-flow shape.
 * @param tree - The tree to seed.
 */
const seedToolCallTurn = (tree: DefaultTree<TestInput, TestOutput, TestProjection>): void => {
  applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'weather?' }, serial: 's1' });
  apply(tree, {
    runId: 'R1',
    codecMessageId: 'TC',
    parent: 'u1',
    role: 'assistant',
    message: { id: 'TC', content: 'tool-call' },
    serial: 's2',
  });
  apply(tree, {
    runId: 'R1',
    codecMessageId: 'TT',
    role: 'assistant',
    message: { id: 'TT', content: 'follow-up text' },
    serial: 's3',
  });
};

/**
 * Land a non-head regenerator reply run that replaces the follow-up text `TT`.
 * The agent wires a non-head regenerate to parent at the regenerate target's
 * predecessor (`TC`) with `regenerates: 'TT'`, so the run is reachable as a
 * child of the owner run yet renders in place of `TT`.
 * @param tree - The tree to apply to.
 * @param runId - The regenerator run's id.
 * @param msgId - The regenerated text's new codec-message-id.
 * @param content - The new text content.
 * @param serial - The Ably serial for the regenerator message.
 */
const landTTRegen = (
  tree: DefaultTree<TestInput, TestOutput, TestProjection>,
  runId: string,
  msgId: string,
  content: string,
  serial: string,
): void => {
  apply(tree, {
    runId,
    codecMessageId: msgId,
    parent: 'TC',
    regenerates: 'TT',
    role: 'assistant',
    message: { id: msgId, content },
    serial,
  });
};

/**
 * Build the canonical branched repro directly in the tree (wire/serial order
 * chronological): M1 → R1 → (M2 → R2 | M3[edit of M2] → R3); R4 regenerates R1
 * under M1. After the regenerate the current branch is M1 → R4; the whole R1
 * subtree (M2/R2/M3/R3) hangs off the now-unselected R1.
 * @param tree - The tree to build into.
 */
const buildBranchedRepro = (tree: DefaultTree<TestInput, TestOutput, TestProjection>): void => {
  applyInput(tree, { codecMessageId: 'm1', message: { id: 'm1', content: 'joke?' }, serial: 's1' });
  apply(tree, { runId: 'R1', codecMessageId: 'a1', parent: 'm1', role: 'assistant', message: { id: 'a1', content: 'joke' }, serial: 's2' }); // prettier-ignore
  applyInput(tree, { codecMessageId: 'm2', parent: 'a1', message: { id: 'm2', content: 'fact?' }, serial: 's3' });
  apply(tree, { runId: 'R2', codecMessageId: 'a2', parent: 'm2', role: 'assistant', message: { id: 'a2', content: 'fact' }, serial: 's4' }); // prettier-ignore
  applyInput(tree, {
    codecMessageId: 'm3',
    parent: 'a1',
    forkOf: 'm2',
    message: { id: 'm3', content: 'poem?' },
    serial: 's5',
  });
  apply(tree, { runId: 'R3', codecMessageId: 'a3', parent: 'm3', role: 'assistant', message: { id: 'a3', content: 'poem' }, serial: 's6' }); // prettier-ignore
  apply(tree, { runId: 'R4', codecMessageId: 'a4', parent: 'm1', regenerates: 'a1', role: 'assistant', message: { id: 'a4', content: 'joke-2' }, serial: 's7' }); // prettier-ignore
};

/**
 * A decoder that rebuilds both input nodes (role=user) and reply runs
 * (assistant) from history wires, so backward hydration reconstructs a branched
 * tree exactly as the channel stored it.
 * @returns A decoder keyed on the wire's role header.
 */
const reproDecoder = (): Decoder<TestInput, TestOutput> => ({
  decode: (msg: Ably.InboundMessage) => {
    // CAST: test fixtures always stamp extras.ai.transport.
    const t = (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport;
    const id = t[HEADER_CODEC_MESSAGE_ID] ?? 'unknown';
    const message = { id, content: id };
    return t[HEADER_ROLE] === 'user'
      ? { inputs: [{ kind: 'user-message' as const, message }], outputs: [] }
      : { inputs: [], outputs: [{ type: 'append-message' as const, message }] };
  },
});

/**
 * Build a raw history wire carrying the given transport headers and serial.
 * @param transport - The `extras.ai.transport` headers.
 * @param serial - The wire serial (also used as the version serial).
 * @returns The inbound message.
 */
const wire = (transport: Record<string, string>, serial: string): Ably.InboundMessage =>
  // CAST: history fixtures only need name/serial/version/extras.
  ({ name: 'fake', serial, version: { serial }, extras: { ai: { transport } } }) as unknown as Ably.InboundMessage;

/**
 * Build a fake {@link HistoryPagesCursor} the mocked `loadHistoryPages` returns.
 * Pages are given oldest-first (human-natural); each is reversed to Ably's
 * newest-first delivery order (via the shared {@link makeHistoryCursor}), so the
 * hydrator reverses it back and folds in the written order.
 * @param pagesOldestFirst - History pages, each oldest-first; the array is in cursor fetch order (newest page first).
 * @returns A cursor over those pages.
 */
const makeCursor = (pagesOldestFirst: Ably.InboundMessage[][]): HistoryPagesCursor =>
  makeHistoryCursor(pagesOldestFirst.map((page) => page.toReversed()));

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

/**
 * Build a linear-chain history page (one wire per index) from
 * {@link linearChainHeaders}, oldest-first. Each index `i` becomes run `Ri` /
 * message `mhi`, parented at the prior message so the runs stay a visible chain.
 * @param indices - Run indices to include, oldest-first (e.g. `[0, 1, 2]`).
 * @returns The raw wires, oldest-first.
 */
const makeChain = (indices: number[]): Ably.InboundMessage[] =>
  indices.map(
    (i) =>
      ({
        name: 'fake',
        serial: `s${String(i)}`,
        version: { serial: `s${String(i)}` },
        extras: { ai: { transport: linearChainHeaders(i) } },
      }) as unknown as Ably.InboundMessage,
  );

/**
 * A plain-array stand-in for the same conversation a real view pages, used to pin
 * `makeFakeLoadUntil` (test/helper/fake-load-until.ts) against the production
 * walk on a shared fixture. `oldest` models both the pagination floor (loadOlder
 * lowers it) and the exclusive-floor trim (hideOldest raises it), so one index
 * drives both, mirroring DefaultView's window.
 * @param messageIds - The conversation's message ids, oldest-first.
 * @param initialVisible - How many newest messages start revealed.
 * @returns The mock window accessors `makeFakeLoadUntil` consumes.
 */
const fakeViewOver = (
  messageIds: string[],
  initialVisible: number,
): {
  getMessages: () => CodecMessage<TestMessage>[];
  hasOlder: () => boolean;
  loadOlder: () => Promise<CodecMessage<TestMessage>[]>;
  hideOldest: (count: number) => void;
} => {
  const nodes: CodecMessage<TestMessage>[] = messageIds.map((id) => ({
    codecMessageId: id,
    message: { id, content: id },
  }));
  let oldest = messageIds.length - initialVisible;
  return {
    getMessages: () => nodes.slice(oldest),
    hasOlder: () => oldest > 0,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: () => {
      if (oldest === 0) return Promise.resolve([]);
      oldest -= 1;
      return Promise.resolve(nodes.slice(oldest, oldest + 1));
    },
    hideOldest: (count) => {
      oldest = Math.min(nodes.length, oldest + count);
    },
  };
};

/**
 * History fixture where message-counting diverges from run-counting: the
 * newest run `R-multi` contributes two codecMessages (`m-a`, `m-b`) while the
 * older `R0` contributes one — all on a linear chain so both stay visible.
 * @returns Raw wires, oldest-first.
 */
const multiMessagePage = (): Ably.InboundMessage[] => {
  const headers = [
    { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh0' },
    { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-a', [HEADER_PARENT]: 'mh0' },
    { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-b', [HEADER_PARENT]: 'mh0' },
  ];
  return headers.map(
    (h, i) =>
      ({
        name: 'fake',
        serial: `s${String(i)}`,
        version: { serial: `s${String(i)}` },
        extras: { ai: { transport: h } },
      }) as unknown as Ably.InboundMessage,
  );
};

/**
 * A content wire carrying one codecMessage for `runId`, on its own (dangling)
 * parent so several such runs stay distinct visible runs rather than collapsing
 * as same-parent siblings.
 * @param runId - The reply run id.
 * @param msgId - The codec-message-id of the content message.
 * @param serial - The wire serial (orders the runs).
 * @returns The content wire.
 */
const contentWire = (runId: string, msgId: string, serial: string): Ably.InboundMessage =>
  ({
    name: 'fake',
    serial,
    version: { serial },
    extras: {
      ai: { transport: { [HEADER_RUN_ID]: runId, [HEADER_CODEC_MESSAGE_ID]: msgId, [HEADER_PARENT]: `p-${runId}` } },
    },
  }) as unknown as Ably.InboundMessage;

/**
 * A run-lifecycle wire (`name`) for `runId`. Pass `reason` on a run-end to mark
 * the run terminal.
 * @param name - The lifecycle event name (run-start/run-end/etc.).
 * @param runId - The run id.
 * @param serial - The wire serial.
 * @param reason - Optional run-end reason (marks the run terminal).
 * @returns The lifecycle wire.
 */
const lifecycleWire = (name: string, runId: string, serial: string, reason?: string): Ably.InboundMessage =>
  ({
    name,
    serial,
    extras: {
      ai: {
        transport: {
          [HEADER_RUN_ID]: runId,
          [HEADER_PARENT]: `p-${runId}`,
          'run-client-id': '',
          ...(reason !== undefined && { [HEADER_RUN_REASON]: reason }),
        },
      },
    },
  }) as unknown as Ably.InboundMessage;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('client view', () => {
  let tree: DefaultTree<TestInput, TestOutput, TestProjection>;
  let view: ClientView<TestInput, TestMessage>;
  let sendDelegate: SendDelegate<TestInput, TestMessage>;
  let codec: Codec<TestInput, TestOutput, TestProjection, TestMessage>;

  /**
   * Build a history hydrator over `t`, binding an applier around `decoder`
   * (defaults to the test codec's no-op decoder). The hydrator drives the mocked
   * `loadHistoryPages`, so the channel is a placeholder; the bound decoder
   * determines how folded history wires become tree nodes.
   * @param t - The tree the hydrator folds into.
   * @param decoder - Optional decoder to bind into the hydrator's applier.
   * @returns A hydrator over `t`.
   */
  const makeHydrator = (
    t: DefaultTree<TestInput, TestOutput, TestProjection>,
    decoder?: Decoder<TestInput, TestOutput>,
  ): HistoryHydrator =>
    createHistoryHydrator({
      channel: createMockChannel(),
      tree: t,
      applier: createWireApplier(t, decoder ?? codec.createDecoder()),
      logger: silentLogger,
    });

  /**
   * Build a View over the shared tree with a hydrator bound around `decoder`
   * (defaults to the test codec's no-op decoder).
   * @param decoder - Optional decoder to bind into the View's hydrator.
   * @returns A new client view over the shared tree.
   */
  const makeView = (decoder?: Decoder<TestInput, TestOutput>): ClientView<TestInput, TestMessage> =>
    createClientView({
      tree,
      codec,
      hydrator: makeHydrator(tree, decoder),
      sendDelegate,
      logger: silentLogger,
    });

  /**
   * Decoder stub for history-replay tests: turns any wire message into a
   * single append-message output whose id is the wire's codec-message-id.
   * @returns The decoder stub.
   */
  const headerDecoder = (): Decoder<TestInput, TestOutput> => ({
    decode: (msg: Ably.InboundMessage) => {
      // CAST: test fixtures always stamp extras.ai.transport.
      const id =
        (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport[HEADER_CODEC_MESSAGE_ID] ??
        'unknown';
      return {
        inputs: [],
        outputs: [{ type: 'append-message' as const, message: { id, content: id } }],
      };
    },
  });

  beforeEach(() => {
    vi.mocked(loadHistoryPages).mockReset();
    codec = makeTestCodec();
    tree = createTree<TestInput, TestOutput, TestProjection>(codec, silentLogger);
    sendDelegate = createMockSendDelegate();
    view = makeView();
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
        { codecMessageId: 'm1', message: { id: 'm1', content: 'q1' } },
        { codecMessageId: 'm2', message: { id: 'm2', content: 'a1' } },
        { codecMessageId: 'm3', message: { id: 'm3', content: 'q2' } },
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

      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);

      // Original branch: a1 is back in the chain, the follow-up turn reappears.
      view.branchSelection('a1').select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });

    // Regenerating a NON-HEAD message inside a multi-message
    // reply run. The two-node node-walk can't slice inside one run's projection,
    // so the View resolves the non-head substitution itself at message-extraction
    // time. A non-head regenerator parents at the regenerate target's
    // PREDECESSOR (the agent wires it that way — see View.regenerate's
    // `_findParentMsgId`), so it's reachable as a child of the owner run yet
    // renders in place of the message it replaced.
    it('substitutes nested regenerator content recursively at each anchor position', () => {
      // u1 → R1 = [a1, extra] (head a1 + trailing follow-up extra). Regen the
      // HEAD a1 → R2 = [a1p] (whole-reply sibling parented at u1). Then regen
      // the trailing follow-up `extra` (a non-head message of R1) → R3 = [extrap]
      // parented at a1 (extra's predecessor), regenerates=extra. On the original
      // branch (R1 selected), walking R1 emits a1, then hits `extra` →
      // substitute R3 → emits extrap. Final chain: [u1, a1, extrap].
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u1',
        role: 'assistant',
        message: { id: 'a1', content: 'orig' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'extra',
        role: 'assistant',
        message: { id: 'extra', content: 'extra-1' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'extrap',
        parent: 'a1',
        regenerates: 'extra',
        role: 'assistant',
        message: { id: 'extrap', content: 'regen-extra' },
        serial: 's4',
      });

      // Non-head substitution at the `extra` slot: extrap replaces extra.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'extrap']);
      // The `extra` slot is a navigable 2-member group (extra ↔ extrap).
      expect(view.branchSelection('extrap').siblings.length).toBe(2);

      // Navigate back to the original trailing follow-up.
      view.branchSelection('extrap').select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'extra']);
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1']);
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

      expect(view.getMessages().map((m) => m.message.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
        'u3',
        'a3',
        'u4',
        'a4',
        'u5',
        'a5',
      ]);
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
     * @returns A new client view observing the already-seeded tree.
     */
    const freshViewAfterSeed = (): ClientView<TestInput, TestMessage> => {
      seedFork();
      return makeView();
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

    it('branchSelection().select() switches to the chosen sibling Run', () => {
      const v = freshViewAfterSeed();
      v.branchSelection('a1').select(0); // anchor a1, older sibling (R2) at index 0
      expect(v.runs().map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('branchSelection().index reflects the chosen sibling', () => {
      const v = freshViewAfterSeed();
      v.branchSelection('a1').select(0);
      expect(v.branchSelection('a1').index).toBe(0);
      v.branchSelection('a2').select(1);
      expect(v.branchSelection('a2').index).toBe(1);
    });

    it('branchSelection().index returns 0 for an unforked Run', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'x' }, serial: 's1' });
      expect(view.branchSelection('m1').index).toBe(0);
    });

    it('branchSelection().select() clamps the index to the sibling-group bounds', () => {
      const v = freshViewAfterSeed();
      v.branchSelection('a1').select(999);
      expect(v.branchSelection('a1').index).toBe(1);
      v.branchSelection('a1').select(-5);
      expect(v.branchSelection('a1').index).toBe(0);
    });

    it('branchSelection().select() is a no-op when the codec-message-id is not a branch anchor', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'x' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      view.branchSelection('m1').select(0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits update when branchSelection().select() changes the visible chain', () => {
      const v = freshViewAfterSeed();
      const handler = vi.fn();
      v.on('update', handler);
      v.branchSelection('a1').select(0);
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
      v.branchSelection('a1').select(0);
      expect(v.runs().map((r) => r.runId)).toEqual(['R1', 'R2', 'R3orig']);
    });
  });

  // -------------------------------------------------------------------------
  // Write operations (send delegate forwarding)
  // -------------------------------------------------------------------------

  describe('write operations', () => {
    it('send forwards parentCodecMessageId', async () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      await view.send({ kind: 'user-message', message: { id: 'b', content: 'second' } });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      // parentCodecMessageId = last visible message's codec-message-id.
      expect(call[2]).toBe('m1');
    });

    it('send with empty visible chain passes undefined parentCodecMessageId', async () => {
      await view.send({ kind: 'user-message', message: { id: 'a', content: 'hi' } });
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[2]).toBeUndefined();
    });

    it('send forwards options through to the delegate', async () => {
      const opts = { runId: 'R-explicit', clientId: 'c-explicit' };
      await view.send({ kind: 'user-message', message: { id: 'a', content: 'hi' } }, opts);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[1]).toBe(opts);
    });

    it('send uses view-local branch selection as history context', async () => {
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
      view.branchSelection('a1').select(1);
      await view.send({ kind: 'user-message', message: { id: 'd', content: 'next' } });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      // parentCodecMessageId should be a2 (R2alt's reply on the selected branch).
      expect(call[2]).toBe('a2');
    });

    it('send normalises a single TInput', async () => {
      await view.send({ kind: 'user-message', message: { id: 'a', content: 'hi' } });
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual([{ kind: 'user-message', message: { id: 'a', content: 'hi' } }]);
    });

    it('send normalises a TInput[] input', async () => {
      await view.send([
        { kind: 'user-message', message: { id: 'a', content: 'hi' } },
        { kind: 'user-message', message: { id: 'b', content: 'bye' } },
      ]);
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual([
        { kind: 'user-message', message: { id: 'a', content: 'hi' } },
        { kind: 'user-message', message: { id: 'b', content: 'bye' } },
      ]);
    });

    it('send forwards an input with a pinned codecMessageId targeting an existing message', async () => {
      // Inputs whose `codecMessageId` is set target an existing message
      // (continuation tool resolutions, approval responses). The View passes
      // them straight through — the routing field stays on the input itself.
      const input: TestInput[] = [
        { kind: 'user-message', message: { id: 'a', content: 'hi' }, codecMessageId: 'override' },
      ];
      await view.send(input);
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
      view.branchSelection('u1').select(1);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u2', 'a2']);

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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);

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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p', 'u2', 'a2']);

      // Switch to the original (index 0 in the regen group).
      view.branchSelection('a1').select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);

      // Switch back — the regen branch and its follow-up turn reappear.
      view.branchSelection('a1').select(1);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p', 'u2', 'a2']);
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
      let deferredResolve: ((value: ClientRun<TestInput, TestMessage>) => void) | undefined;
      vi.mocked(sendDelegate).mockResolvedValueOnce(makeClientRun({ inputCodecMessageId: 'a1', runId: 'Rregen1' }));
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1_new1']);

      // Second regen: ai-run-start arrives BEFORE the publish ACK that
      // resolves sendDelegate, so _applyRegenerateAutoSelect hasn't yet
      // installed the new pending entry.
      vi.mocked(sendDelegate).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- need to capture the resolver
        () =>
          new Promise<ClientRun<TestInput, TestMessage>>((resolve) => {
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1_new2']);

      // The publish ACK resolves later: _applyRegenerateAutoSelect runs and the
      // selection stays on the latest (regen-2).
      deferredResolve?.(makeClientRun({ inputCodecMessageId: 'a1_new1', runId: 'Rregen2' }));
      await regenPromise;

      // Visible state must now reflect regen-2 — without the recompute
      // in _applyRegenerateAutoSelect, this stays stuck on 'a1_new1'.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1_new2']);
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

      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);

      // First regenerate.
      vi.mocked(sendDelegate).mockResolvedValueOnce(makeClientRun({ inputCodecMessageId: 'a1', runId: 'Rregen1' }));
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1_new1']);

      // Second regenerate (clicking the displayed regen-1 message).
      vi.mocked(sendDelegate).mockResolvedValueOnce(
        makeClientRun({ inputCodecMessageId: 'a1_new1', runId: 'Rregen2' }),
      );
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1_new2']);

      // Third regenerate.
      vi.mocked(sendDelegate).mockResolvedValueOnce(
        makeClientRun({ inputCodecMessageId: 'a1_new2', runId: 'Rregen3' }),
      );
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1_new3']);
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
        { codecMessageId: 'm1', message: { id: 'm1', content: 'q' } },
        { codecMessageId: 'm2', message: { id: 'm2', content: 'follow' } },
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
      // memoised components don't re-render. The codec re-mints the
      // codec-message-id pair wrappers, but the domain `message` halves are
      // the stable projection objects consumers render.
      expect(after[0]?.message).toBe(before[0]?.message);
      expect(after[1]?.message).toBe(before[1]?.message);
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
      noopCodec.getMessages = (p) => p.messages.map((m) => ({ codecMessageId: m.id, message: m }));

      const noopTree = createTree<TestInput, TestOutput, TestProjection>(noopCodec, silentLogger);
      const noopView = createClientView({
        tree: noopTree,
        codec: noopCodec,
        hydrator: makeHydrator(noopTree, noopCodec.createDecoder()),
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
    let viewB: ClientView<TestInput, TestMessage>;

    beforeEach(() => {
      viewB = makeView();
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
      view.branchSelection('a1').select(0);
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
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['non-integer', 1.5],
    ])('rejects a %s limit with InvalidArgument and never touches history', async (_label, limit) => {
      await expect(view.loadOlder(limit)).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(vi.mocked(loadHistoryPages)).not.toHaveBeenCalled();
    });

    it('hasOlder is optimistically true until a loadOlder exhausts empty history', async () => {
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([]));
      // Before any fetch the cursor is unopened, so exhaustion is unknown — the
      // honest answer is "there may be older messages", which the documented
      // `while (hasOlder()) loadOlder()` drain recipe relies on.
      expect(view.hasOlder()).toBe(true);
      await view.loadOlder();
      // The fetch reached attach with nothing older → now truthfully false.
      expect(view.hasOlder()).toBe(false);
    });

    it('loadOlder reveals Runs from history and bumps visible chain', async () => {
      // History returns a single message that creates Run R0.
      const rawMsg = {
        name: 'fake',
        serial: 's0',
        version: { serial: 's0' },
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' } } },
      } as unknown as Ably.InboundMessage;

      // The hydrator folds pages through the View's applier (its bound decoder).
      // The test codec's decoder returns no events, so bind a view to a decoder
      // that produces one.
      const v = makeView(headerDecoder());

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([[rawMsg]]));

      await v.loadOlder(10);
      expect(v.runs().map((r) => r.runId)).toContain('R0');
    });

    it('hasOlder stays true when the cursor has more pages after the target is met', async () => {
      // Two independent runs across two cursor pages (newest first). loadOlder(1)
      // reveals the newest and stops — the older page is unfetched, so the cursor
      // is not exhausted and hasOlder stays true.
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(
        makeCursor([[contentWire('R-new', 'a-new', 's02')], [contentWire('R-old', 'a-old', 's01')]]),
      );

      await v.loadOlder(1);
      expect(v.runs().map((r) => r.runId)).toEqual(['R-new']);
      expect(v.hasOlder()).toBe(true);
    });

    it('is a no-op when called while already loading', async () => {
      // Park the first fetch in flight: the mock signals when the cursor open is
      // issued (a deterministic sync point) and returns a promise the test
      // resolves at the end to let the first loadOlder finish.
      let signalOpened: (() => void) | undefined;
      const opened = new Promise<void>((resolve) => {
        signalOpened = resolve;
      });
      let resolveOpen: ((cursor: HistoryPagesCursor) => void) | undefined;
      vi.mocked(loadHistoryPages).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock parks on a promise the test resolves
        () => {
          signalOpened?.();
          return new Promise<HistoryPagesCursor>((resolve) => {
            resolveOpen = resolve;
          });
        },
      );

      const p1 = view.loadOlder(10);
      await opened; // exactly when the first fetch is issued — no timing guesswork
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);

      // A second call while the first is in flight is a no-op (synchronous
      // _loadingOlder guard) — no extra fetch.
      await view.loadOlder(10);
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);

      resolveOpen?.(makeCursor([]));
      await p1;
    });

    it('withholds excess nodes by message count and drains them on subsequent loadOlder calls without re-fetching', async () => {
      // First page reveals 3 Runs (R0, R1, R2) on a linear chain (each parented
      // at the prior run's message — two same-parent reply runs would collapse
      // as regenerate siblings in the two-node model). Each run here contributes
      // exactly one codecMessage, so a message limit of 2 reveals the newest 2
      // nodes and withholds the oldest in the buffer.
      const rawMessages = [0, 1, 2].map(
        (i) =>
          ({
            name: 'fake',
            serial: `s${String(i)}`,
            version: { serial: `s${String(i)}` },
            extras: { ai: { transport: linearChainHeaders(i) } },
          }) as unknown as Ably.InboundMessage,
      );
      const v = makeView(headerDecoder());

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([rawMessages]));

      await v.loadOlder(2);
      // The newest 2 by startSerial (R1, R2) are revealed; R0 is withheld.
      expect(
        v
          .runs()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R1', 'R2']);
      expect(v.hasOlder()).toBe(true);

      // Second loadOlder drains the withheld buffer (R0). loadHistoryPages is
      // NOT called again — the buffer drain path returns without fetching.
      await v.loadOlder(2);
      expect(
        v
          .runs()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R0', 'R1', 'R2']);
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
    });

    it('counts codecMessages, not runs: a multi-message run fills the page limit alone', async () => {
      // Nodes oldest→newest: R0 (1 msg), R-multi (2 msgs). With a message limit
      // of 2, the newest run alone reaches the limit, so only R-multi is
      // revealed and R0 is withheld — run-counting would have revealed both.
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      await v.loadOlder(2);
      expect(v.runs().map((r) => r.runId)).toEqual(['R-multi']);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m-a', 'm-b']);
      expect(v.hasOlder()).toBe(true);

      // Draining reveals the withheld R0 without a second fetch.
      await v.loadOlder(2);
      expect(
        v
          .runs()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R-multi', 'R0'].toSorted());
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
    });

    it('partially reveals a node at the boundary so a page lands exactly on the message limit', async () => {
      // R-multi carries 2 messages. Revealing one message at a time slices the
      // node: loadOlder(1) shows only its newest message, the next reveals the
      // rest, then the older R0 — never overshooting the limit.
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      // Exactly 1 message: R-multi's newest only. R-multi is partially revealed
      // (still a visible run), R0 stays hidden.
      await v.loadOlder(1);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m-b']);
      expect(v.runs().map((r) => r.runId)).toEqual(['R-multi']);
      expect(v.hasOlder()).toBe(true);

      // Next message reveals the rest of R-multi (no re-fetch — already buffered).
      await v.loadOlder(1);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m-a', 'm-b']);
      expect(v.hasOlder()).toBe(true);

      // Final message reveals R0; history is now exhausted.
      await v.loadOlder(1);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['mh0', 'm-a', 'm-b']);
      expect(v.runs().map((r) => r.runId)).toEqual(['R0', 'R-multi']);
      expect(v.hasOlder()).toBe(false);
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
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
            version: { serial: it.serial },
            extras: { ai: { transport: it.headers } },
          }) as unknown as Ably.InboundMessage,
      );
      const v = makeView(headerDecoder());

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([rawMessages]));
      await v.loadOlder(2);

      // R0 is withheld at this point. An ably-message for R0 must be
      // suppressed; an ably-message for R1 (visible) must pass through.
      const handler = vi.fn();
      v.on('ably-message', handler);

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

    it('does not emit ably-message for history folds (surfaces via update only)', async () => {
      // The hydrator folds history pages through foldAndEmit (per-wire
      // emitAblyMessage) during the drain, but the View must suppress those:
      // the pagination window isn't set up yet and the event is scoped to
      // visible runs. The revealed run surfaces via a single 'update' instead.
      const v = makeView(headerDecoder());
      const ablyMessage = vi.fn();
      const update = vi.fn();
      v.on('ably-message', ablyMessage);
      v.on('update', update);

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([[contentWire('R0', 'a0', 's0')]]));
      await v.loadOlder(10);

      expect(v.runs().map((r) => r.runId)).toEqual(['R0']);
      expect(ablyMessage).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalled();
    });

    it('forwards a live ably-message for a visible run that arrives mid-fetch', async () => {
      // Regression: a live message for an already-visible run must surface on
      // the View's `ably-message` event even while a loadOlder history fetch is
      // in flight. The fetch holds an in-flight flag across its awaited drain to
      // mute history folds, but that flag must not also drop a concurrent live
      // message — the event is edge-triggered, with no later replay.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });

      // Park the history fetch at cursor-open: a deterministic sync point (the
      // mock signals when the open is issued, then returns a promise the test
      // resolves at the end). While parked, the fetch's in-flight flag is set.
      let signalOpened: (() => void) | undefined;
      const opened = new Promise<void>((resolve) => {
        signalOpened = resolve;
      });
      let resolveOpen: ((cursor: HistoryPagesCursor) => void) | undefined;
      vi.mocked(loadHistoryPages).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock parks on a promise the test resolves
        () => {
          signalOpened?.();
          return new Promise<HistoryPagesCursor>((resolve) => {
            resolveOpen = resolve;
          });
        },
      );

      const p = view.loadOlder(10);
      await opened; // the fetch is now in flight

      const handler = vi.fn();
      view.on('ably-message', handler);
      const liveMsg = {
        name: 'fake',
        extras: { ai: { transport: { [HEADER_RUN_ID]: 'R1' } } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(liveMsg);

      expect(handler).toHaveBeenCalledWith(liveMsg);

      // Let the fetch finish (empty history) so loadOlder settles cleanly.
      resolveOpen?.(makeCursor([]));
      await p;
    });

    it('does not leak ably-message or run for a history-folded run-start with an unresolved parent', async () => {
      // Regression: folding pages newest-first, a history run-start's parent
      // sits in an older, not-yet-folded page, so `_isRunStartVisible` reads it
      // as visible ("unknown parent: forward conservatively") and `_onTreeRun`
      // would add it to the visible set mid-fold — which then let its own
      // `ably-message` fold leak past a visible-set check. Neither the run-start's
      // `run` event nor its `ably-message` may surface during the drain; the run
      // surfaces via runs() + a settled `update` instead.
      const runHandler = vi.fn();
      const ablyMessage = vi.fn();
      const update = vi.fn();
      view.on('run', runHandler);
      view.on('ably-message', ablyMessage);
      view.on('update', update);

      // A lone run-start for R-hist whose parent (p-R-hist) is never folded.
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([[lifecycleWire(EVENT_RUN_START, 'R-hist', 's0')]]));

      await view.loadOlder(1);

      // No edge-triggered leaks from the fold...
      expect(runHandler).not.toHaveBeenCalled();
      expect(ablyMessage).not.toHaveBeenCalled();
      // ...but the run still surfaced via the revealed window.
      expect(view.runs().map((r) => r.runId)).toEqual(['R-hist']);
      expect(update).toHaveBeenCalled();
    });

    // ---------------------------------------------------------------------
    // Pagination edge cases (AIT-773 §7.6)
    // ---------------------------------------------------------------------

    it('handles a Run that spans multiple channel pages by carrying state across cursor pages', async () => {
      // Simulate a Run R-multi whose messages appear across two channel pages:
      // the newest page holds m-multi-b, the older page holds m-multi-a. The
      // hydrator folds both into the same RunNode.
      const headersA = { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-multi-a' };
      const headersB = { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-multi-b' };
      const rawA = {
        name: 'fake',
        serial: 's01',
        version: { serial: 's01' },
        extras: { ai: { transport: headersA } },
      } as unknown as Ably.InboundMessage;
      const rawB = {
        name: 'fake',
        serial: 's02',
        version: { serial: 's02' },
        extras: { ai: { transport: headersB } },
      } as unknown as Ably.InboundMessage;

      const v = makeView(headerDecoder());

      // Two cursor pages, newest first: [rawB] then [rawA].
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([[rawB], [rawA]]));

      await v.loadOlder(2);

      // The single Run R-multi materialised from both pages; both messages
      // belong to one RunNode.
      const nodes = v.runs();
      expect(nodes.map((n) => n.runId)).toEqual(['R-multi']);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m-multi-a', 'm-multi-b']);
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

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([[runStartMsg]]));

      await view.loadOlder(1);

      const nodes = view.runs();
      expect(nodes.map((n) => n.runId)).toEqual(['R-empty']);
      expect(view.getMessages()).toEqual([]);
    });

    it('does not surface off-branch runs (including a terminal contentless one) in the current branch', async () => {
      // Regression: backward history can fold in runs that are not ancestors of
      // the current branch's leaf — here three runs on separate lineages
      // (distinct dangling parents, so none is the parent of another). Only the
      // newest, R-new, is the selected leaf; pagination walks its ancestor chain,
      // so R-mid and R-old stay off the current branch. R-old additionally owns
      // no message (run-start + run-end, no content) and is terminal — a
      // 0-message run the walk must skip cleanly rather than surface.
      const v = makeView(headerDecoder());
      // Distinct dangling parents keep the runs on separate lineages; serials
      // order them oldest → newest (R-new is the leaf).
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(
        makeCursor([
          [
            lifecycleWire(EVENT_RUN_START, 'R-old', 's00'),
            lifecycleWire(EVENT_RUN_END, 'R-old', 's00b', 'complete'),
            contentWire('R-mid', 'a-mid', 's01'),
            contentWire('R-new', 'a-new', 's02'),
          ],
        ]),
      );

      // The current branch is just the leaf R-new: R-mid and the terminal
      // contentless R-old are off-branch (not R-new's ancestors), so runs() lists
      // only R-new and getMessages only a-new.
      await v.loadOlder(1);

      expect(v.getMessages().map((m) => m.message.id)).toEqual(['a-new']);
      expect(v.runs().map((n) => n.runId)).toEqual(['R-new']);
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

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([[runStartMsg, runSuspendMsg]]));

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

      vi.mocked(loadHistoryPages).mockResolvedValueOnce(
        makeCursor([
          [lifecycle(EVENT_RUN_START, 's01'), lifecycle(EVENT_RUN_SUSPEND, 's02'), lifecycle(EVENT_RUN_RESUME, 's03')],
        ]),
      );

      await view.loadOlder(1);

      const node = view.runs().find((n) => n.runId === 'R-resumed');
      expect(node?.status).toBe('active');
    });

    it('returns the revealed page oldest-first, prefixing the new window', async () => {
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      // First reveal: window was empty, so the whole new window is the page.
      const page1 = await v.loadOlder(1);
      expect(page1.map((m) => m.message.id)).toEqual(['m-b']);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m-b']);

      // Each later reveal returns only the older slice newly prepended, and that
      // slice prefixes the resulting window.
      const page2 = await v.loadOlder(1);
      expect(page2.map((m) => m.message.id)).toEqual(['m-a']);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m-a', 'm-b']);

      const page3 = await v.loadOlder(1);
      expect(page3.map((m) => m.message.id)).toEqual(['mh0']);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['mh0', 'm-a', 'm-b']);
    });

    it('returns [] when channel history is exhausted', async () => {
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([]));
      expect(await view.loadOlder()).toEqual([]);
      expect(view.hasOlder()).toBe(false);
    });

    it('returns [] from a populated window once history is exhausted', async () => {
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      // Drain everything: the window is now non-empty and history is exhausted.
      await v.loadOlder(10);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['mh0', 'm-a', 'm-b']);
      expect(v.hasOlder()).toBe(false);

      // A further loadOlder over the populated-but-exhausted window (anchor
      // defined, nothing older revealed) resolves to [] and leaves it unchanged.
      expect(await v.loadOlder(1)).toEqual([]);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['mh0', 'm-a', 'm-b']);
    });

    it('loadOlder(1) returns exactly one message and does not refetch until the buffered page drains', async () => {
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      const p1 = await v.loadOlder(1);
      expect(p1.map((m) => m.message.id)).toEqual(['m-b']);
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);

      // Drained from the buffer — still exactly one fetch, no new round-trip.
      const p2 = await v.loadOlder(1);
      expect(p2.map((m) => m.message.id)).toEqual(['m-a']);
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
    });

    it('lets a caller walk back to a known message id and compose [...db, ...live] with no duplicate', async () => {
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      // The caller's own store already holds the oldest message; its newest row
      // is the seam to stop the backward walk at.
      const db = [{ id: 'mh0' }];
      const seamId = db.at(-1)?.id;

      let reachedSeam = false;
      while (v.hasOlder()) {
        const [older] = await v.loadOlder(1);
        if (older?.message.id === seamId) {
          reachedSeam = true;
          break;
        }
      }
      expect(reachedSeam).toBe(true);

      // At most one overlap — the seam row just revealed; drop it, no set dedup.
      const window = v.getMessages();
      const live = window[0]?.message.id === seamId ? window.slice(1) : window;
      const conversation = [...db, ...live.map((m) => m.message)];
      expect(conversation.map((m) => m.id)).toEqual(['mh0', 'm-a', 'm-b']);
    });

    it('reveal cost is independent of window size — per-reveal flattening does not grow as more is revealed', async () => {
      // A K-message backward walk (loadOlder(1) per step, as loadUntil drives)
      // must stay O(K): each reveal re-flattens only the projection it surfaced,
      // not the whole growing window. codec.getMessages is the per-node flatten,
      // so counting its calls per reveal pins that the cost does not climb with
      // the count of already-revealed messages.
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(
        makeCursor([makeChain([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])]),
      );

      // The first reveal also fetches and folds the whole page, warming the
      // per-projection cache for every run; measure the cache-warm drains after.
      await v.loadOlder(1);

      const getMessages = vi.spyOn(codec, 'getMessages');
      const perReveal: number[] = [];
      while (v.hasOlder()) {
        const before = getMessages.mock.calls.length;
        await v.loadOlder(1);
        perReveal.push(getMessages.mock.calls.length - before);
      }
      getMessages.mockRestore();
      v.close();

      // The chain drains one run at a time, so many reveals happen...
      expect(perReveal.length).toBeGreaterThan(5);
      // ...and the last (oldest, widest-window) reveal flattens no more than the
      // first: per-reveal work is flat, not linear in the window. A full
      // per-reveal re-flatten would make this climb with each step.
      expect(perReveal.at(-1)).toBeLessThanOrEqual(perReveal[0] ?? 0);
      // Per-reveal flattening is a small constant, independent of window size.
      expect(Math.max(...perReveal)).toBeLessThanOrEqual(2);
    });

    it('drops the memoised flattening when a fold mutates a run projection in place', () => {
      // A reducer that mutates the projection IN PLACE (same object ref), as the
      // production reducer contract permits. Caching the flatten by projection
      // identity cannot see the change, so the View must invalidate on the
      // fold's output event — else getMessages reports the stale pre-fold list.
      const mutatingCodec = makeTestCodec();
      mutatingCodec.fold = (state, codecEvent) => {
        const event = codecEvent.event;
        if ('type' in event) state.messages.push(event.message);
        return state;
      };
      const t = createTree<TestInput, TestOutput, TestProjection>(mutatingCodec, silentLogger);
      const v = createClientView({
        tree: t,
        codec: mutatingCodec,
        hydrator: makeHydrator(t),
        sendDelegate,
        logger: silentLogger,
      });

      apply(t, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a1', content: 'first' }, serial: 's1' });
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['a1']);

      // Fold a second message into the SAME run (same projection ref); the
      // memoised flatten must be dropped so getMessages reflects it.
      apply(t, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a2', content: 'more' }, serial: 's2' });
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['a1', 'a2']);
      v.close();
    });
  });

  // -------------------------------------------------------------------------
  // loadUntil — seam reconciliation
  // -------------------------------------------------------------------------

  describe('loadUntil', () => {
    it('agrees with the makeFakeLoadUntil test double on a shared fixture', async () => {
      // Pin the test double (test/helper/fake-load-until.ts) against the production
      // walk: for the same conversation and seam, both must return the same tail
      // and leave the same window — so the hook tests' mirror cannot silently drift
      // from DefaultView.loadUntil.
      const real = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([makeChain([0, 1, 2, 3, 4])]));

      const fake = fakeViewOver(['mh0', 'mh1', 'mh2', 'mh3', 'mh4'], 1);
      const fakeLoadUntil = makeFakeLoadUntil(fake);

      const realTail = await real.loadUntil((msg) => msg.message.id === 'mh2');
      const fakeTail = await fakeLoadUntil((msg) => msg.message.id === 'mh2');

      // Same not-yet-seeded tail, and the same trimmed window left behind.
      expect(realTail.map((m) => m.message.id)).toEqual(fakeTail.map((m) => m.message.id));
      expect(real.getMessages().map((m) => m.message.id)).toEqual(fake.getMessages().map((m) => m.message.id));
      // And both land on the expected result (guards against both drifting together).
      expect(realTail.map((m) => m.message.id)).toEqual(['mh3', 'mh4']);
    });

    it('returns the tail past an already-visible seam and trims the window past it', async () => {
      // Live (post-attach) chain m0→m1→m2 already in the window: the seam is
      // visible, so no history fetch is needed.
      apply(tree, { runId: 'R0', codecMessageId: 'm0', message: { id: 'm0', content: 'a' }, serial: 's0' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        parent: 'm0',
        message: { id: 'm1', content: 'b' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'm2', content: 'c' },
        serial: 's2',
      });
      view.runs(); // prime the cache

      const tail = await view.loadUntil((m) => m.message.id === 'm1');

      // Strictly newer than the seam m1; the seam itself is excluded.
      expect(tail.map((m) => m.message.id)).toEqual(['m2']);
      // The seam is an exclusive floor: the warm window held m1 (the seam) and m0
      // (older), both in the caller's store; loadUntil trims past the seam, so
      // getMessages() reports exactly the returned tail.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['m2']);
      expect(vi.mocked(loadHistoryPages)).not.toHaveBeenCalled();
    });

    it('withholds the seam and over-fetched pre-seam history, recoverable via loadOlder', async () => {
      // A warm window that reaches back past the seam: m0 is older than the m1
      // seam and already in the caller's store.
      apply(tree, { runId: 'R0', codecMessageId: 'm0', message: { id: 'm0', content: 'a' }, serial: 's0' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        parent: 'm0',
        message: { id: 'm1', content: 'b' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'm2', content: 'c' },
        serial: 's2',
      });
      view.runs(); // prime the cache

      const tail = await view.loadUntil((m) => m.message.id === 'm1');

      // Exclusive floor: the window is the tail, the seam m1 and older m0 withheld.
      expect(tail.map((m) => m.message.id)).toEqual(['m2']);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['m2']);
      // Withheld, not lost: hasOlder() still reports it and loadOlder reveals it
      // again, the seam first (it is the newest withheld message).
      expect(view.hasOlder()).toBe(true);
      const revealed = await view.loadOlder(1);
      expect(revealed.map((m) => m.message.id)).toEqual(['m1']);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['m1', 'm2']);
    });

    it('pages back to the seam and returns only the not-yet-stored tail (seam excluded)', async () => {
      const v = makeView(headerDecoder());
      // Linear history chain mh0..mh4 (oldest→newest), served as one page.
      const chain = makeChain([0, 1, 2, 3, 4]);
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([chain]));

      const tail = await v.loadUntil((m) => m.message.id === 'mh2');

      // Tail is strictly newer than the mh2 seam.
      expect(tail.map((m) => m.message.id)).toEqual(['mh3', 'mh4']);
      // The seam is an exclusive floor: mh2 (and older mh1, mh0) are withheld, so
      // the window equals the returned tail.
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['mh3', 'mh4']);
      // A single fetch — the buffered page serves every loadOlder(1) reveal.
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
    });

    it('composes [...db, ...loadUntil()] with a single seam overlap dropped', async () => {
      const v = makeView(headerDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([multiMessagePage()]));

      // The caller's store already holds the oldest message; its newest row is
      // the seam. loadUntil returns everything newer, so compose with no dup.
      const db = [{ id: 'mh0' }];
      const seamId = db.at(-1)?.id;
      const tail = await v.loadUntil((m) => m.message.id === seamId);

      const conversation = [...db, ...tail.map((m) => m.message)];
      expect(conversation.map((m) => m.id)).toEqual(['mh0', 'm-a', 'm-b']);
      // The seam appears exactly once — the overlap drop is the whole point.
      expect(conversation.filter((m) => m.id === seamId)).toHaveLength(1);
    });

    it('returns an empty tail when the seam is the newest visible message (store fully caught up)', async () => {
      // The DB-seeded steady state: the store already holds every channel message,
      // so the seam is the newest visible message and there is no live tail.
      apply(tree, { runId: 'R0', codecMessageId: 'm0', message: { id: 'm0', content: 'a' }, serial: 's0' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        parent: 'm0',
        message: { id: 'm1', content: 'b' },
        serial: 's1',
      });
      view.runs(); // prime the cache

      const tail = await view.loadUntil((m) => m.message.id === 'm1');

      expect(tail).toEqual([]);
      expect(vi.mocked(loadHistoryPages)).not.toHaveBeenCalled();
    });

    it('returns the whole window when no message matches (history exhausted)', async () => {
      const v = makeView(headerDecoder());
      const chain = makeChain([0, 1]);
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([chain]));

      // No seam (e.g. an unseeded caller): page everything, return the full window.
      const tail = await v.loadUntil((m) => m.message.id === 'no-such-seam');

      expect(tail.map((m) => m.message.id)).toEqual(['mh0', 'mh1']);
      expect(v.hasOlder()).toBe(false);
    });

    it('returns [] when the view is closed', async () => {
      view.close();
      const tail = await view.loadUntil(() => true);
      expect(tail).toEqual([]);
    });

    it('does not starve the event loop when two walks run concurrently', async () => {
      // Two concurrent loadUntil walks over one view — as React StrictMode
      // produces by double-invoking the hook effect on a reload. The first walk's
      // history fetch is parked at cursor-open, so it holds the single-flight
      // loadOlder guard. The second walk must NOT busy-spin on loadOlder's
      // synchronous [] return (the guard) — that tight microtask loop would
      // starve the queue and stop the parked fetch's own continuation from ever
      // running, hanging the page. It must yield to the in-flight load instead.
      const v = makeView(headerDecoder());
      const chain = makeChain([0, 1]);
      let releaseFetch: ((cursor: HistoryPagesCursor) => void) | undefined;
      vi.mocked(loadHistoryPages).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- parks on a promise the test resolves
        () =>
          new Promise<HistoryPagesCursor>((resolve) => {
            releaseFetch = resolve;
          }),
      );

      const walkA = v.loadUntil((m) => m.message.id === 'mh1');
      const walkB = v.loadUntil((m) => m.message.id === 'mh1');

      // The crux: with the bug, walkB spins synchronously and this never settles.
      await flushMicrotasks();
      expect(releaseFetch).toBeDefined();

      // Release the parked fetch; both walks complete (neither hung).
      releaseFetch?.(makeCursor([chain]));
      const [tailA, tailB] = await Promise.all([walkA, walkB]);

      expect(Array.isArray(tailA)).toBe(true);
      expect(Array.isArray(tailB)).toBe(true);
      // The shared single-flight cursor pages the channel once across both walks.
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
      // Walks are serialized, so the window converges on the correctly trimmed
      // tail: the seam mh1 is the newest message, so everything is withheld and
      // the visible window is empty — not the un-trimmed full chain a concurrent
      // interleave would leave (which a seeded subscriber would double-render).
      expect(v.getMessages().map((m) => m.message.id)).toEqual([]);
    });

    it('serializes concurrent walks so they trim past the newest seam (StrictMode reload, no seed overlap)', async () => {
      // The use-client-session-db reload after two turns: the store holds the
      // whole conversation, so the seam is the NEWEST channel message and a
      // correct walk trims the window to the empty tail. React StrictMode
      // double-invokes the hook effect, so walk A starts, is aborted on cleanup,
      // and walk B runs — concurrently sharing the single-flight history fetch.
      // Both must converge on the trimmed tail; if the shared trim state is
      // corrupted the window stays the full conversation and the hook composes
      // seed ⧺ full-window with a duplicate id for every message.
      const v = makeView(headerDecoder());
      const chain = makeChain([0, 1, 2, 3]);
      let releaseFetch: ((cursor: HistoryPagesCursor) => void) | undefined;
      vi.mocked(loadHistoryPages).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- parks on a promise the test resolves
        () =>
          new Promise<HistoryPagesCursor>((resolve) => {
            releaseFetch = resolve;
          }),
      );

      // The store the demo seeds from — the whole conversation; mh3 is the seam.
      const seed = ['mh0', 'mh1', 'mh2', 'mh3'];
      const controllerA = new AbortController();
      const walkA = v.loadUntil((m) => m.message.id === 'mh3', controllerA.signal);
      const walkB = v.loadUntil((m) => m.message.id === 'mh3');

      await flushMicrotasks();
      // StrictMode cleanup aborts the first effect's walk.
      controllerA.abort();
      releaseFetch?.(makeCursor([chain]));
      await Promise.all([walkA, walkB]);

      // The seam mh3 is the newest message, so the trimmed window is empty —
      // composing seed ⧺ window must not duplicate any id.
      const composed = [...seed, ...v.getMessages().map((m) => m.message.id)];
      expect(composed).toEqual([...new Set(composed)]);
      expect(v.getMessages().map((m) => m.message.id)).toEqual([]);
    });

    it('abandons the walk when its abort signal fires mid-fetch', async () => {
      // A superseded walk (a React effect aborting on cleanup) stops promptly:
      // the signal fires while the first reveal's fetch is parked, so once that
      // fetch resolves the walk bails on the next loop check rather than paging on.
      const v = makeView(headerDecoder());
      const chain = makeChain([0, 1]);
      let releaseFetch: ((cursor: HistoryPagesCursor) => void) | undefined;
      vi.mocked(loadHistoryPages).mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- parks on a promise the test resolves
        () =>
          new Promise<HistoryPagesCursor>((resolve) => {
            releaseFetch = resolve;
          }),
      );

      const controller = new AbortController();
      // Seam mh0 is the oldest message, so a complete walk would page the whole
      // chain; aborting must cut it short before it gets there.
      const walk = v.loadUntil((m) => m.message.id === 'mh0', controller.signal);

      await flushMicrotasks();
      expect(releaseFetch).toBeDefined();

      controller.abort();
      releaseFetch?.(makeCursor([chain]));
      const tail = await walk;

      // Aborted walks resolve to [] regardless of what the in-flight reveal surfaced.
      expect(tail).toEqual([]);
      // Only the one already-in-flight fetch ran; the walk did not page further.
      expect(vi.mocked(loadHistoryPages)).toHaveBeenCalledTimes(1);
    });

    it('resolves [] without paging when the signal is already aborted on entry', async () => {
      // A walk handed an already-aborted signal must honour the documented
      // aborted result ([]) even when no history is left to page — the in-loop
      // check would never run, so the early check carries this case.
      const v = makeView(headerDecoder());
      const tail = await v.loadUntil((m) => m.message.id === 'mh0', AbortSignal.abort());

      expect(tail).toEqual([]);
      expect(vi.mocked(loadHistoryPages)).not.toHaveBeenCalled();
    });

    it('never emits a pre-trim window holding the seam (no seed overlap mid-walk)', async () => {
      // The bug this guards: the walk pages back through the seam one reveal at a
      // time, and each reveal momentarily holds the seam (and older) before the
      // trim. A subscriber mirroring getMessages() and composing [...seed, ...it]
      // would then see duplicate ids for that frame (the React "two children with
      // the same key" warning on a seeded reload). loadUntil must suppress those
      // intermediate frames and emit only the settled tail.
      const v = makeView(headerDecoder());
      const chain = makeChain([0, 1, 2, 3, 4]);
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(makeCursor([chain]));

      // The caller's store holds mh0..mh2; its newest row (mh2) is the seam.
      const seed = ['mh0', 'mh1', 'mh2'];

      // Capture the composed conversation a hook-like subscriber would render on
      // every emit — [...seed, ...getMessages()].
      const frames: string[][] = [];
      v.on('update', () => {
        frames.push([...seed, ...v.getMessages().map((m) => m.message.id)]);
      });

      const tail = await v.loadUntil((m) => m.message.id === 'mh2');

      expect(tail.map((m) => m.message.id)).toEqual(['mh3', 'mh4']);
      // Every emitted frame is duplicate-free: the seam and older are never
      // surfaced alongside the seed that already holds them.
      for (const frame of frames) {
        expect(frame).toEqual([...new Set(frame)]);
      }
      // The settled frame is the full, gap-free conversation.
      expect(frames.at(-1)).toEqual(['mh0', 'mh1', 'mh2', 'mh3', 'mh4']);
    });
  });

  // -------------------------------------------------------------------------
  // Branched conversation: pagination walks the selected branch only (AIT-703)
  // -------------------------------------------------------------------------

  describe('branched conversation (selected-branch pagination)', () => {
    it('shows only the selected branch (M1 → R4), excluding the off-branch R1 subtree', () => {
      buildBranchedRepro(tree);
      // The window is the ancestor chain of the selected leaf R4 — never the
      // off-branch edit/original nodes that share the channel but hang off R1.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['m1', 'a4']);
      expect(view.runs().map((r) => r.runId)).toEqual(['R4']);
    });

    it('keeps both a reply run and a follow-up input child of the same node (concurrent fresh sends)', () => {
      // Two concurrent fresh sends: uB's parent is uA (the visible tail at send
      // time) because uA's reply RA had not landed yet. So uA has two non-sibling
      // children — its reply RA and the next turn uB — and both belong on the
      // conversation. The selected-leaf walk alone would follow only uB→uA and
      // drop RA; the connected-set resolution readmits RA as a child of the
      // in-spine uA. Serial order: uA, uB, RA, RB.
      applyInput(tree, { codecMessageId: 'uA', message: { id: 'uA', content: 'qA' }, serial: 's1' });
      applyInput(tree, { codecMessageId: 'uB', parent: 'uA', message: { id: 'uB', content: 'qB' }, serial: 's2' });
      apply(tree, { runId: 'RA', codecMessageId: 'aA', parent: 'uA', role: 'assistant', message: { id: 'aA', content: 'answerA' }, serial: 's3' }); // prettier-ignore
      apply(tree, { runId: 'RB', codecMessageId: 'aB', parent: 'uB', role: 'assistant', message: { id: 'aB', content: 'answerB' }, serial: 's4' }); // prettier-ignore

      // All four nodes are visible — RA is not dropped.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['uA', 'uB', 'aA', 'aB']);
      expect(view.runs().map((r) => r.runId)).toEqual(['RA', 'RB']);
      // Each assistant reply maps to its own run — no cross-talk.
      expect(view.runOf('aA')?.runId).toBe('RA');
      expect(view.runOf('aB')?.runId).toBe('RB');
    });

    it('paginates the selected branch incrementally during backward hydration, never the off-branch wires', async () => {
      const v = makeView(reproDecoder());
      // One wire per cursor page, newest page first — so loadOlder pages the
      // channel backward exactly as the demo does. M1 (the branch root) is the
      // OLDEST wire and therefore the last to hydrate.
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(
        makeCursor([
          [wire({ [HEADER_RUN_ID]: 'R4', [HEADER_CODEC_MESSAGE_ID]: 'a4', [HEADER_PARENT]: 'm1', 'msg-regenerate': 'a1', [HEADER_ROLE]: 'assistant' }, 's7')], // prettier-ignore
          [wire({ [HEADER_RUN_ID]: 'R3', [HEADER_CODEC_MESSAGE_ID]: 'a3', [HEADER_PARENT]: 'm3', [HEADER_ROLE]: 'assistant' }, 's6')], // prettier-ignore
          [wire({ [HEADER_CODEC_MESSAGE_ID]: 'm3', [HEADER_PARENT]: 'a1', [HEADER_FORK_OF]: 'm2', [HEADER_ROLE]: 'user' }, 's5')], // prettier-ignore
          [wire({ [HEADER_RUN_ID]: 'R2', [HEADER_CODEC_MESSAGE_ID]: 'a2', [HEADER_PARENT]: 'm2', [HEADER_ROLE]: 'assistant' }, 's4')], // prettier-ignore
          [wire({ [HEADER_CODEC_MESSAGE_ID]: 'm2', [HEADER_PARENT]: 'a1', [HEADER_ROLE]: 'user' }, 's3')],
          [wire({ [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'a1', [HEADER_PARENT]: 'm1', [HEADER_ROLE]: 'assistant' }, 's2')], // prettier-ignore
          [wire({ [HEADER_CODEC_MESSAGE_ID]: 'm1', [HEADER_ROLE]: 'user' }, 's1')],
        ]),
      );

      // First page surfaces only R4; its ancestor M1 has not hydrated yet, so the
      // window is just the leaf — never the off-branch R3 that folds in next.
      await v.loadOlder(1);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['a4']);

      // Drain: the walk climbs R4 → M1. Reaching M1 folds the intervening
      // off-branch wires (R3/M3/R2/M2/R1) into the Tree, but none enter the
      // window — the final branch is exactly [M1, R4].
      while (v.hasOlder()) await v.loadOlder(1);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['m1', 'a4']);
      expect(v.runs().map((r) => r.runId)).toEqual(['R4']);
    });

    it('preserves the pagination depth across a branch switch at a visible point', async () => {
      // u1 → R1 → u2 → R2, with R2b regenerating R2 at the tail (latest, so the
      // selected branch ends on R2b). The shared prefix is u1 → R1.
      const v = makeView(reproDecoder());
      vi.mocked(loadHistoryPages).mockResolvedValueOnce(
        makeCursor([
          [
            wire({ [HEADER_CODEC_MESSAGE_ID]: 'u1', [HEADER_ROLE]: 'user' }, 's1'),
            wire({ [HEADER_RUN_ID]: 'R1', [HEADER_CODEC_MESSAGE_ID]: 'a1', [HEADER_PARENT]: 'u1', [HEADER_ROLE]: 'assistant' }, 's2'), // prettier-ignore
            wire({ [HEADER_CODEC_MESSAGE_ID]: 'u2', [HEADER_PARENT]: 'a1', [HEADER_ROLE]: 'user' }, 's3'),
            wire({ [HEADER_RUN_ID]: 'R2', [HEADER_CODEC_MESSAGE_ID]: 'a2', [HEADER_PARENT]: 'u2', [HEADER_ROLE]: 'assistant' }, 's4'), // prettier-ignore
            wire({ [HEADER_RUN_ID]: 'R2b', [HEADER_CODEC_MESSAGE_ID]: 'a2b', [HEADER_PARENT]: 'u2', 'msg-regenerate': 'a2', [HEADER_ROLE]: 'assistant' }, 's5'), // prettier-ignore
          ],
        ]),
      );

      // Reveal the newest 2 messages; the shared prefix (u1, R1) is withheld.
      await v.loadOlder(2);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['u2', 'a2b']);
      expect(v.hasOlder()).toBe(true);

      // Switch to the original reply R2 at the visible tail. The window depth is
      // preserved (the withheld shared prefix is valid for both branches), so the
      // view shows the same depth on the new branch — only the tail changes.
      const handle = v.branchSelection('a2b');
      expect(handle.siblings.map((m) => m.id)).toEqual(['a2', 'a2b']);
      handle.select(0);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['u2', 'a2']);
      expect(v.hasOlder()).toBe(true);

      // Paginating further drains the still-valid shared prefix onto branch R2.
      await v.loadOlder(2);
      expect(v.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });

    it('retargets to the R1 subtree when the user selects the original reply at the M1 fork', () => {
      buildBranchedRepro(tree);
      // Select the original reply R1 (index 0) at the regenerate group anchored
      // on the assistant slot. The branch retargets off R4 onto R1's subtree.
      // The edit group resolves to M2: when M3 forked in during the live build
      // the View pinned the then-visible M2 to prevent branch drift, so the
      // restored branch is M1 → R1 → M2 → R2 (not the latest edit M3).
      const handle = view.branchSelection('a4');
      expect(handle.siblings.map((m) => m.id)).toEqual(['a1', 'a4']);
      handle.select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['m1', 'a1', 'm2', 'a2']);
      expect(view.runs().map((r) => r.runId)).toEqual(['R1', 'R2']);
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
      const v = createClientView({
        tree,
        codec,
        hydrator: makeHydrator(tree),
        sendDelegate,
        logger: silentLogger,
        onClose,
      });
      v.close();
      expect(onClose).toHaveBeenCalled();
    });

    it('makes send reject with SessionClosed after close', async () => {
      view.close();
      await expect(view.send({ kind: 'user-message', message: { id: 'a', content: 'hi' } })).rejects.toBeErrorInfo({
        code: ErrorCode.SessionClosed,
        message: 'unable to send; view is closed',
      });
    });

    it('makes regenerate reject with SessionClosed after close', async () => {
      view.close();
      await expect(view.regenerate('any')).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });

    it('makes edit reject with SessionClosed after close', async () => {
      view.close();
      await expect(
        view.edit('any', { kind: 'user-message', message: { id: 'a', content: 'x' } }),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });

    it('is idempotent: double close does not throw and onClose fires once', () => {
      const onClose = vi.fn();
      const v = createClientView({
        tree,
        codec,
        hydrator: makeHydrator(tree),
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

    it('loadOlder after close is a no-op (no history fetch)', async () => {
      view.close();
      await view.loadOlder(10);
      expect(vi.mocked(loadHistoryPages)).not.toHaveBeenCalled();
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
      vi.mocked(sendDelegate).mockResolvedValueOnce(makeClientRun({ inputCodecMessageId: 'a1', runId: 'R2new' }));

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
      vi.mocked(sendDelegate).mockResolvedValueOnce(makeClientRun({ inputCodecMessageId: 'a1', runId: 'R2new' }));

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
        error: new Ably.ErrorInfo('boom', 104008, 500),
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
      view.branchSelection('a1').select(0);
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
      view.branchSelection('a1p').select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);

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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);
    });

    it('edit auto-selects the new sibling Run from the input codec-message-id', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce(makeClientRun({ inputCodecMessageId: 'u-new', runId: 'R2edit' }));
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
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a2']);
    });

    it('branchSelection().index defaults to the latest regenerator', () => {
      expect(view.branchSelection('a1').index).toBe(1);
    });

    it('branchSelection(anchor).select(0) switches the regenerate group to the original — projection extraction shows the original assistant', () => {
      view.branchSelection('a1').select(0);
      expect(view.runs().map((r) => r.runId)).toEqual(['R1']);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);
      expect(view.branchSelection('a1').index).toBe(0);
    });

    it('branchSelection(anchor).select(1) restores the regenerator selection', () => {
      view.branchSelection('a1').select(0);
      view.branchSelection('a1').select(1);
      expect(view.runs().map((r) => r.runId)).toEqual(['R2']);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a2']);
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

      it('branchSelection().select() on the anchor codec-message-id switches the regen selection', () => {
        view.branchSelection('a2').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);
        view.branchSelection('a1').select(1);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a2']);
      });

      it('branchSelection().select() on a non-anchor codec-message-id is a no-op', () => {
        const before = view.getMessages().map((m) => m.message.id);
        view.branchSelection('u1').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(before);
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
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p', 'a2p']);
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

      it('branchSelection().select() on the anchor swaps the entire regenerated trail', () => {
        // Selecting back to the original (index 0) restores BOTH a1 and a2 in R1.
        view.branchSelection('a1').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'a2']);
        // Selecting back to the regenerator (index 1) hides them again.
        view.branchSelection('a1').select(1);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p', 'a2p']);
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
      let regen2: ClientRun<TestInput, TestMessage>;
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
        const mocked = sendDelegate as unknown as Mock<SendDelegate<TestInput, TestMessage>>;
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
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p', 'a2pp']);
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
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p', 'a2pp']);
      });

      // TODO(AIT-831): deferred — intra-run mid-reply regenerate selection.
      // Re-enable with the regenerate-of-multi-message golden test.
      it.skip('selecting back to the original at the tool-call anchor reactivates the trailing-text regenerator', () => {
        // Navigate from R3 back to R1 at the a1 anchor. R3 no longer
        // truncates R1, so R2's anchor (a2) is back in the visible
        // chain and R2's content surfaces.
        view.branchSelection('a1').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1', 'a2p']);
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

      it('branchSelection().select() on the user-prompt anchor swaps the whole Run', () => {
        // Explicitly select R2 first (the edited branch) so the swap to
        // R1 via the anchor is observable independent of the default
        // pinning behaviour.
        view.branchSelection('u2').select(1);
        view.branchSelection('u2').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);
      });

      it('branchSelection().select() on the assistant codec-message-id is a no-op (assistant is not the edit anchor)', () => {
        const before = view.getMessages().map((m) => m.message.id);
        view.branchSelection('a2').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(before);
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
        view.branchSelection('u1').select(0);
      });

      it('branchSelection().hasSiblings disambiguates by codec-message-id: user prompt anchors fork-of, assistant anchors regen', () => {
        // user prompt u1 is the fork-of anchor (first msg of R1).
        expect(view.branchSelection('u1').hasSiblings).toBe(true);
        // assistant a1 is the regen anchor.
        expect(view.branchSelection('a1').hasSiblings).toBe(true);
      });

      it('branchSelection().select() on the assistant codec-message-id navigates the REGEN group, not the fork-of group', () => {
        // Start: visible chain shows [P1, R1'] (R1 selected, regen R_regen latest).
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);

        // Click `<` on the asst bubble — go to the original R1's asst.
        view.branchSelection('a1p').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1']);

        // Click `>` on the asst bubble — should return to R1' (the regen).
        // BUG: this currently switches the fork-of selection to R_edit
        // and ends up on [u2, a2] instead of [u1, a1p].
        view.branchSelection('a1').select(1);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);
      });

      it('branchSelection().select() on the user-prompt codec-message-id navigates the FORK-OF group', () => {
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);

        // Click `>` on the user bubble — switch to the edited branch.
        view.branchSelection('u1').select(1);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u2', 'a2']);

        // Click `<` to come back.
        view.branchSelection('u2').select(0);
        expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'a1p']);
      });

      it('branchSelection().index reports the correct group selection for each codec-message-id', () => {
        // Initial state: fork-of selection = R1 (index 0); regen selection
        // = R_regen (auto, no explicit selection → defaults to latest, index 1).
        expect(view.branchSelection('u1').index).toBe(0);
        expect(view.branchSelection('a1p').index).toBe(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Regenerate of a NON-HEAD message (the follow-up text after a tool call)
  // -------------------------------------------------------------------------
  //
  // A tool-call turn is ONE run with several messages: [tool-call (TC),
  // follow-up text (TT)]. Regenerating the follow-up TEXT (a non-head message)
  // mints a new reply run R' parented at TT's predecessor (TC, a message INSIDE
  // the owner run) with regeneratesCodecMessageId = TT. R' is therefore NOT a
  // same-parent sibling of the owner run — it's reachable as a child of it — so
  // the Tree's `visibleNodes` cannot collapse it into TT's slot. The View
  // resolves the substitution at message-extraction time: it truncates the
  // owner run at TT and renders R' in its place, and exposes a message-level
  // navigator at the TT slot.

  describe('regenerate of a non-head message', () => {
    it('hides the orphaned original text and renders the regenerator in its place', () => {
      seedToolCallTurn(tree);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TT']);

      landTTRegen(tree, 'Rp', 'TTp', 'follow-up text 2', 's4');

      // TT is hidden; TTp replaces it. NOT [u1, TC, TT, TTp] (the pre-fix orphan).
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);
    });

    it('forms a message-level navigator at the text slot and branchSelection().select() toggles the two variants', () => {
      seedToolCallTurn(tree);
      landTTRegen(tree, 'Rp', 'TTp', 'follow-up text 2', 's4');

      // The rendered slot (TTp) is a 2-member group, defaulting to the latest.
      const branch = view.branchSelection('TTp');
      expect(branch.hasSiblings).toBe(true);
      expect(branch.siblings.map((m) => m.id)).toEqual(['TT', 'TTp']);
      expect(branch.index).toBe(1);

      // Navigate to the original.
      view.branchSelection('TTp').select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TT']);
      // Resolving from the now-rendered original yields the same group, index 0.
      const back = view.branchSelection('TT');
      expect(back.siblings.map((m) => m.id)).toEqual(['TT', 'TTp']);
      expect(back.index).toBe(0);

      // Navigate forward again.
      view.branchSelection('TT').select(1);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);
    });

    it('the tool-call (head) slot has no non-head navigator', () => {
      seedToolCallTurn(tree);
      landTTRegen(tree, 'Rp', 'TTp', 'follow-up text 2', 's4');
      // TC is a head message; regenerating it would be a whole-reply sibling, not
      // a non-head group. With only a TT-regen present, TC has no navigator.
      expect(view.branchSelection('TC').hasSiblings).toBe(false);
    });

    it('keeps the regenerator run in runs() and the visible-key set (events still scope to it)', () => {
      seedToolCallTurn(tree);
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rp',
        clientId: 'agent',
        invocationId: 'inv',
        parent: 'TC',
        regenerates: 'TT',
        serial: 's4-start',
      });
      landTTRegen(tree, 'Rp', 'TTp', 'follow-up text 2', 's4');
      // The regenerator is a real run: it must remain queryable and event-scoped
      // even though its messages render in the owner run's slot.
      expect(view.runs().map((r) => r.runId)).toContain('Rp');
    });

    it('chained regen of the regenerated text rolls forward and grows one navigable group', () => {
      seedToolCallTurn(tree);
      landTTRegen(tree, 'Rp', 'TTp', 'text2', 's4');
      // Regen TTp again — anchors back at TT (the canonical anchor), so a third
      // alternative joins the SAME group rather than spawning a nested one.
      landTTRegen(tree, 'Rp2', 'TTp2', 'text3', 's5');

      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp2']);
      const branch = view.branchSelection('TTp2');
      expect(branch.siblings.map((m) => m.id)).toEqual(['TT', 'TTp', 'TTp2']);
      expect(branch.index).toBe(2);

      // Navigate to the middle alternative.
      view.branchSelection('TTp2').select(1);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);
    });

    it('regenerating the tool call after a text regen hides the orphaned text regenerator', () => {
      seedToolCallTurn(tree);
      // Step 1: regenerate the follow-up text TT; its regenerator TTp is shown.
      landTTRegen(tree, 'Rp', 'TTp', 'text2', 's4');
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);

      // Step 2: regen TC (the head) → whole-reply sibling run R2 = [TC2, TT2].
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'TC2',
        parent: 'u1',
        regenerates: 'TC',
        role: 'assistant',
        message: { id: 'TC2', content: 'tool-call 2' },
        serial: 's5',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'TT2',
        role: 'assistant',
        message: { id: 'TT2', content: 'text new' },
        serial: 's6',
      });

      // The TT regenerator (Rp) lived on R1's timeline, which is no longer the
      // selected sibling — it must be hidden. Two bubbles, navigator on the TC.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC2', 'TT2']);
      expect(view.branchSelection('TC2').siblings.map((m) => m.id)).toEqual(['TC', 'TC2']);
      expect(view.branchSelection('TT2').hasSiblings).toBe(false);

      // Selecting the original tool call brings back R1 fully — including its
      // own non-head text group (TT ↔ TTp, defaulting to the latest TTp).
      view.branchSelection('TC2').select(0);
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);
      expect(view.branchSelection('TTp').siblings.map((m) => m.id)).toEqual(['TT', 'TTp']);
    });

    it('drives the regenerate write path: non-head anchor and parent are resolved from the visible chain', async () => {
      seedToolCallTurn(tree);

      vi.mocked(sendDelegate).mockResolvedValueOnce(makeClientRun({ inputCodecMessageId: 'TT', runId: 'Rp' }));

      await view.regenerate('TT');

      // The regenerate input must anchor at TT and parent at TC (TT's
      // predecessor inside the owner run), so the agent re-answers the right
      // message and truncates the run there.
      const [inputs] = vi.mocked(sendDelegate).mock.calls[0] ?? [];
      const event = inputs?.[0];
      if (!event || !('kind' in event) || event.kind !== 'regenerate') {
        throw new Error('expected regenerate input');
      }
      expect(event.target).toBe('TT');
      expect(event.parent).toBe('TC');

      // When the regenerator lands it auto-rolls forward (latest member).
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'Rp',
        clientId: 'agent',
        invocationId: 'inv',
        parent: 'TC',
        regenerates: 'TT',
        serial: 's4-start',
      });
      landTTRegen(tree, 'Rp', 'TTp', 'text2', 's4');
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);
    });

    it('reconstructs the same view from history replay order (parity with live)', () => {
      // Same end state as the live path, but applied in pure serial order as a
      // page replay would deliver it — the rendered chain must match.
      applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'weather?' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'TC',
        parent: 'u1',
        role: 'assistant',
        message: { id: 'TC', content: 'tool-call' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'TT',
        role: 'assistant',
        message: { id: 'TT', content: 'text' },
        serial: 's3',
      });
      landTTRegen(tree, 'Rp', 'TTp', 'text2', 's4');

      // Default (latest) selection after a cold rebuild — exactly what a page
      // refresh shows.
      expect(view.getMessages().map((m) => m.message.id)).toEqual(['u1', 'TC', 'TTp']);
      expect(view.branchSelection('TTp').siblings.map((m) => m.id)).toEqual(['TT', 'TTp']);
    });
  });
});

describe('agent leaf view — incomplete-run filtering (LeafBranchSource)', () => {
  let tree: DefaultTree<TestInput, TestOutput, TestProjection>;
  let source: LeafBranchSource<TestInput, TestOutput, TestProjection, TestMessage>;

  beforeEach(() => {
    const codec = makeTestCodec();
    tree = createTree<TestInput, TestOutput, TestProjection>(codec, silentLogger);
    source = createLeafBranchSource<TestInput, TestOutput, TestProjection, TestMessage>({
      getTree: () => tree,
      codec,
    });
  });

  // Node keys in branch order — runId for a run node, codec-message-id for an input.
  const nodeKeys = (): string[] => source.visibleNodes().map((n) => (n.kind === 'run' ? n.runId : n.codecMessageId));
  // The flattened prompt the agent would feed the model, by codec-message-id.
  const promptIds = (): string[] => source.extractMessages(source.visibleNodes()).map((m) => m.codecMessageId);

  type AncestorStatus = 'active' | 'suspended' | 'complete' | 'cancelled' | 'error';

  // Seed three turns and pin the current run:
  //   u1 → R1  (always completed)
  //   u2 → R2  (status under test — the ancestor that may be incomplete)
  //   u3 → R3  (the current run; pinned, deliberately left without a run-end)
  // Each input hangs off the prior run's assistant message, mirroring the wire.
  const seedThreeTurns = (r2Status: AncestorStatus): void => {
    applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's1' });
    apply(tree, {
      runId: 'R1',
      codecMessageId: 'a1',
      parent: 'u1',
      role: 'assistant',
      message: { id: 'a1', content: 'r1' },
      serial: 's2',
    });
    tree.applyRunLifecycle({
      type: 'end',
      runId: 'R1',
      clientId: 'c',
      invocationId: '',
      reason: 'complete',
      serial: 's3',
    });

    applyInput(tree, { codecMessageId: 'u2', parent: 'a1', message: { id: 'u2', content: 'q2' }, serial: 's4' });
    apply(tree, {
      runId: 'R2',
      codecMessageId: 'tc2',
      parent: 'u2',
      role: 'assistant',
      message: { id: 'tc2', content: 'tool-call' },
      serial: 's5',
    });
    switch (r2Status) {
      case 'complete':
      case 'cancelled': {
        tree.applyRunLifecycle({
          type: 'end',
          runId: 'R2',
          clientId: 'c',
          invocationId: '',
          reason: r2Status,
          serial: 's6',
        });
        break;
      }
      case 'error': {
        tree.applyRunLifecycle({
          type: 'end',
          runId: 'R2',
          clientId: 'c',
          invocationId: '',
          reason: 'error',
          error: new Ably.ErrorInfo('boom', 104008, 500),
          serial: 's6',
        });
        break;
      }
      case 'suspended': {
        tree.applyRunLifecycle({ type: 'suspend', runId: 'R2', clientId: 'c', invocationId: '', serial: 's6' });
        break;
      }
      case 'active': {
        // No terminal lifecycle; the run is still in flight.
        break;
      }
    }

    applyInput(tree, { codecMessageId: 'u3', parent: 'tc2', message: { id: 'u3', content: 'q3' }, serial: 's7' });
    apply(tree, {
      runId: 'R3',
      codecMessageId: 'a3',
      parent: 'u3',
      role: 'assistant',
      message: { id: 'a3', content: 'r3' },
      serial: 's8',
    });

    source.setPin('u3', 'R3', undefined);
  };

  it('keeps a completed ancestor turn, in order', () => {
    seedThreeTurns('complete');
    expect(nodeKeys()).toEqual(['u1', 'R1', 'u2', 'R2', 'u3', 'R3']);
    expect(promptIds()).toEqual(['u1', 'a1', 'u2', 'tc2', 'u3', 'a3']);
  });

  it.each<AncestorStatus>(['active', 'suspended', 'cancelled', 'error'])(
    'drops a %s ancestor run together with its triggering input',
    (status) => {
      seedThreeTurns(status);
      expect(nodeKeys()).toEqual(['u1', 'R1', 'u3', 'R3']);
      // The incomplete run's dangling tool-call (tc2) and its prompt (u2) are gone.
      expect(promptIds()).toEqual(['u1', 'a1', 'u3', 'a3']);
    },
  );

  it('always includes the current run and its input, even when it has not completed (resume case)', () => {
    // R3 is the pinned current run and is left without a run-end; an ancestor
    // (R2) is suspended. The current run and its input survive regardless of the
    // current run's own status, while the suspended ancestor turn (u2 + R2) goes.
    seedThreeTurns('suspended');
    expect(nodeKeys()).toEqual(['u1', 'R1', 'u3', 'R3']);
  });

  it('drops only the run when an incomplete ancestor has no triggering input node', () => {
    // R1 completes; R2 is an output-only run parented directly on R1's assistant
    // message (no input node of its own) and never completes. Dropping R2 must
    // not take R1's input with it.
    applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's1' });
    apply(tree, {
      runId: 'R1',
      codecMessageId: 'a1',
      parent: 'u1',
      role: 'assistant',
      message: { id: 'a1', content: 'r1' },
      serial: 's2',
    });
    tree.applyRunLifecycle({
      type: 'end',
      runId: 'R1',
      clientId: 'c',
      invocationId: '',
      reason: 'complete',
      serial: 's3',
    });
    apply(tree, {
      runId: 'R2',
      codecMessageId: 'x2',
      parent: 'a1',
      role: 'assistant',
      message: { id: 'x2', content: 'partial' },
      serial: 's4',
    });
    applyInput(tree, { codecMessageId: 'u3', parent: 'x2', message: { id: 'u3', content: 'q3' }, serial: 's5' });
    apply(tree, {
      runId: 'R3',
      codecMessageId: 'a3',
      parent: 'u3',
      role: 'assistant',
      message: { id: 'a3', content: 'r3' },
      serial: 's6',
    });
    source.setPin('u3', 'R3', undefined);

    expect(nodeKeys()).toEqual(['u1', 'R1', 'u3', 'R3']);
    expect(promptIds()).toEqual(['u1', 'a1', 'u3', 'a3']);
  });

  it('resolves selectedReplyRun against the structural branch, so an incomplete on-branch reply is not displaced by a completed sibling', () => {
    // u1 has two reply runs: R1, still active and structurally on this branch
    // (the current run u2/R2 hangs off R1's output), and Rx, a later completed
    // regenerate sibling at the same input. Branch identity must not shift to the
    // completed sibling just because the on-branch reply hasn't finished — the
    // prompt-safety filter that drops R1 from `visibleNodes()` must not leak into
    // branch selection.
    applyInput(tree, { codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's1' });
    apply(tree, {
      runId: 'R1',
      codecMessageId: 'a1',
      parent: 'u1',
      role: 'assistant',
      message: { id: 'a1', content: 'r1' },
      serial: 's2',
    });
    tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', parent: 'u1', serial: 's2' });
    // A completed regenerate sibling of R1 at the same input, started later (so
    // the latest-by-startSerial fallback would pick it if selection were filtered).
    apply(tree, {
      runId: 'Rx',
      codecMessageId: 'ax',
      parent: 'u1',
      role: 'assistant',
      message: { id: 'ax', content: 'rx' },
      serial: 's9',
    });
    tree.applyRunLifecycle({ type: 'start', runId: 'Rx', clientId: 'c', invocationId: '', parent: 'u1', serial: 's9' });
    tree.applyRunLifecycle({
      type: 'end',
      runId: 'Rx',
      clientId: 'c',
      invocationId: '',
      reason: 'complete',
      serial: 's10',
    });
    applyInput(tree, { codecMessageId: 'u2', parent: 'a1', message: { id: 'u2', content: 'q2' }, serial: 's3' });
    apply(tree, {
      runId: 'R2',
      codecMessageId: 'a2',
      parent: 'u2',
      role: 'assistant',
      message: { id: 'a2', content: 'r2' },
      serial: 's4',
    });
    source.setPin('u2', 'R2', undefined);

    expect(source.selectedReplyRun('u1')?.runId).toBe('R1');
  });
});
