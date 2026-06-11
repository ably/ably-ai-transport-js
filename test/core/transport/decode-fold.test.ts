/**
 * applyWireMessage unit tests.
 *
 * The shared decode-fold engine classifies a raw wire message and applies it to
 * the tree — run-lifecycle names via parseRunLifecycle + applyRunLifecycle,
 * everything else via the codec decoder + applyMessage (skipping wire-only
 * carriers). It never emits `ably-message` (the caller owns that) and returns
 * the parsed lifecycle event so a live caller can run its own side-effects.
 */

import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type { CodecInputEvent, Decoder } from '../../../src/core/codec/types.js';
import { applyWireMessage } from '../../../src/core/transport/decode-fold.js';
import type { TreeInternal } from '../../../src/core/transport/tree.js';

// ---------------------------------------------------------------------------
// Test types + mocks
// ---------------------------------------------------------------------------

interface TestInput extends CodecInputEvent {
  kind: 'in';
}
interface TestOutput {
  type: 'out';
}
interface TestProjection {
  x: number;
}

interface MockTree {
  applyRunLifecycle: ReturnType<typeof vi.fn>;
  applyMessage: ReturnType<typeof vi.fn>;
  emitAblyMessage: ReturnType<typeof vi.fn>;
}

const makeTree = (): MockTree => ({
  applyRunLifecycle: vi.fn(),
  applyMessage: vi.fn(),
  emitAblyMessage: vi.fn(),
});

const asTree = (t: MockTree): TreeInternal<TestInput, TestOutput, TestProjection> =>
  // CAST: a minimal stub exposing only the methods applyWireMessage calls.
  t as unknown as TreeInternal<TestInput, TestOutput, TestProjection>;

const makeDecoder = (inputs: TestInput[], outputs: TestOutput[]): Decoder<TestInput, TestOutput> => ({
  decode: vi.fn(() => ({ inputs: [...inputs], outputs: [...outputs] })),
});

const msg = (opts: {
  name?: string;
  headers?: Record<string, string>;
  serial?: string;
  timestamp?: number;
}): Ably.InboundMessage =>
  ({
    name: opts.name ?? 'msg',
    action: 'message.create',
    extras: { ai: { transport: opts.headers ?? {} } },
    serial: opts.serial ?? 's1',
    timestamp: opts.timestamp ?? 1000,
  }) as unknown as Ably.InboundMessage;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyWireMessage', () => {
  describe('run-lifecycle messages', () => {
    it('applies a run-start via applyRunLifecycle and returns the parsed event', () => {
      const tree = makeTree();
      // Capture the decode spy locally — asserting on a Decoder method directly
      // trips the unbound-method lint.
      const decode = vi.fn(() => ({ inputs: [] as TestInput[], outputs: [] as TestOutput[] }));
      const decoder: Decoder<TestInput, TestOutput> = { decode };

      const event = applyWireMessage(
        asTree(tree),
        decoder,
        msg({ name: EVENT_RUN_START, headers: { [HEADER_RUN_ID]: 'R1', 'run-client-id': 'c1' }, serial: 's1' }),
      );

      expect(event).toMatchObject({ type: 'start', runId: 'R1', serial: 's1' });
      expect(tree.applyRunLifecycle).toHaveBeenCalledTimes(1);
      // The message timestamp (fixture default 1000) is threaded onto the event.
      expect(tree.applyRunLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start', runId: 'R1', timestamp: 1000 }),
      );
      // Lifecycle messages never touch the codec decoder or applyMessage.
      expect(decode).not.toHaveBeenCalled();
      expect(tree.applyMessage).not.toHaveBeenCalled();
    });

    it.each([
      [EVENT_RUN_SUSPEND, 'suspend'],
      [EVENT_RUN_RESUME, 'resume'],
      [EVENT_RUN_END, 'end'],
    ])('routes %s through applyRunLifecycle as a %s event', (name, type) => {
      const tree = makeTree();
      const event = applyWireMessage(
        asTree(tree),
        makeDecoder([], []),
        msg({ name, headers: { [HEADER_RUN_ID]: 'R1' } }),
      );
      expect(event).toMatchObject({ type, runId: 'R1' });
      expect(tree.applyRunLifecycle).toHaveBeenCalledWith(expect.objectContaining({ type, runId: 'R1' }));
    });

    it('returns undefined and skips applyRunLifecycle for a lifecycle name carrying no run-id', () => {
      const tree = makeTree();
      const event = applyWireMessage(asTree(tree), makeDecoder([], []), msg({ name: EVENT_RUN_END, headers: {} }));
      expect(event).toBeUndefined();
      expect(tree.applyRunLifecycle).not.toHaveBeenCalled();
      expect(tree.applyMessage).not.toHaveBeenCalled();
    });
  });

  describe('codec messages', () => {
    it('decodes and applies a message carrying events, returning undefined', () => {
      const tree = makeTree();
      const decoder = makeDecoder([], [{ type: 'out' }]);

      const event = applyWireMessage(
        asTree(tree),
        decoder,
        msg({ headers: { [HEADER_RUN_ID]: 'R1' }, serial: 's2', timestamp: 1234 }),
      );

      expect(event).toBeUndefined();
      expect(tree.applyRunLifecycle).not.toHaveBeenCalled();
      expect(tree.applyMessage).toHaveBeenCalledTimes(1);
      expect(tree.applyMessage).toHaveBeenCalledWith(
        { inputs: [], outputs: [{ type: 'out' }] },
        expect.objectContaining({ [HEADER_RUN_ID]: 'R1' }),
        's2',
        1234,
      );
    });

    it('applies a message with no decoded events when it carries a run-id', () => {
      const tree = makeTree();
      applyWireMessage(asTree(tree), makeDecoder([], []), msg({ headers: { [HEADER_RUN_ID]: 'R1' } }));
      expect(tree.applyMessage).toHaveBeenCalledTimes(1);
    });

    it('skips a wire-only carrier that decodes to nothing and carries no run-id', () => {
      const tree = makeTree();
      applyWireMessage(asTree(tree), makeDecoder([], []), msg({ headers: {} }));
      expect(tree.applyMessage).not.toHaveBeenCalled();
    });
  });

  it('never emits ably-message — the caller owns that', () => {
    const tree = makeTree();
    applyWireMessage(asTree(tree), makeDecoder([], [{ type: 'out' }]), msg({ headers: { [HEADER_RUN_ID]: 'R1' } }));
    applyWireMessage(
      asTree(tree),
      makeDecoder([], []),
      msg({ name: EVENT_RUN_START, headers: { [HEADER_RUN_ID]: 'R1' } }),
    );
    expect(tree.emitAblyMessage).not.toHaveBeenCalled();
  });
});
