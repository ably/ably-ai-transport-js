/**
 * createMaterialisation unit tests.
 *
 * The factory pairs a fresh Tree with a ReceiveTransport binding a fresh codec
 * decoder, with the Tree subscribed to the receiver's event streams. Each call
 * must produce an independent pair (a fresh Tree always gets a fresh decoder),
 * and a message delivered through the receiver must fold into that call's Tree.
 * The Tree's fold is bracketed: a throw escaping the Tree apply surfaces on the
 * receiver's `error` stream and suppresses the failed wire's paired
 * `ably-message`, so subscribers never see a raw message the Tree never folded.
 */

import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_START,
  EVENT_STEP_END,
  HEADER_RUN_ID,
  HEADER_STEP_ID,
  HEADER_STEP_START_SERIAL,
} from '../../../src/constants.js';
import type { Decoder } from '../../../src/core/codec/types.js';
import { applyTransportEventToTree, createMaterialisation } from '../../../src/core/transport/materialisation.js';
import { classifyWireMessage } from '../../../src/core/transport/receive-transport.js';
import type { Codec, CodecInputEvent } from '../../../src/core/transport/session-codec.js';
import type { TreeInternal } from '../../../src/core/transport/tree.js';
import type { TransportEvent } from '../../../src/core/transport/types/transport.js';
import { wireMetaFromLocalEcho } from '../../../src/core/transport/wire-meta.js';
import { ErrorCode } from '../../../src/errors.js';
import { silentLogger } from '../../helper/logger.js';
import { foreignWire, inboundMessage, outputMsg } from '../../helper/wire-messages.js';

// ---------------------------------------------------------------------------
// Minimal codec stub: identity-ish reducer + a decoder that yields one output.
// ---------------------------------------------------------------------------

interface TestInput extends CodecInputEvent {
  kind: 'user-message';
}
interface TestOutput {
  type: 'out';
}
interface TestProjection {
  outs: number;
}
interface TestMessage {
  id: string;
}

const makeCodec = (): {
  codec: Codec<TestInput, TestOutput, TestProjection, TestMessage>;
  decoders: Decoder<TestInput, TestOutput>[];
} => {
  const decoders: Decoder<TestInput, TestOutput>[] = [];
  const codec = {
    init: (): TestProjection => ({ outs: 0 }),
    fold: (state: TestProjection, event: { direction: 'input' | 'output' }): TestProjection =>
      event.direction === 'output' ? { outs: state.outs + 1 } : state,
    getMessages: (): never[] => [],
    createDecoder: (): Decoder<TestInput, TestOutput> => {
      const decoder: Decoder<TestInput, TestOutput> = {
        // Mirror a real decoder: an SDK output wire yields one output; a
        // foreign wire (an application's own publish) yields nothing.
        decode: vi.fn((msg: Ably.InboundMessage) => ({
          inputs: [] as TestInput[],
          outputs: msg.name === 'ai-output' ? ([{ type: 'out' }] as TestOutput[]) : [],
        })),
      };
      decoders.push(decoder);
      return decoder;
    },
    // The remaining Codec surface is unused by these tests.
  } as unknown as Codec<TestInput, TestOutput, TestProjection, TestMessage>;
  return { codec, decoders };
};

describe('createMaterialisation', () => {
  it('returns a Tree and a receiver that folds into that Tree', () => {
    const { codec } = makeCodec();
    const { tree, receiver } = createMaterialisation(codec, silentLogger);

    receiver.deliverEvent(outputMsg('s1', 'C1', 'R1'));

    // The fold created the reply run in this materialisation's own Tree.
    expect(tree.getRunNode('R1')).toBeDefined();
  });

  it('creates an independent Tree and decoder on each call', () => {
    const { codec, decoders } = makeCodec();
    const first = createMaterialisation(codec, silentLogger);
    const second = createMaterialisation(codec, silentLogger);

    expect(first.tree).not.toBe(second.tree);
    expect(first.receiver).not.toBe(second.receiver);
    // A fresh decoder is minted per materialisation so stream-tracker state
    // can't leak across Trees.
    expect(decoders).toHaveLength(2);
    expect(decoders[0]).not.toBe(decoders[1]);

    first.receiver.deliverEvent(outputMsg('s1', 'C1', 'R1'));
    expect(first.tree.getRunNode('R1')).toBeDefined();
    expect(second.tree.getRunNode('R1')).toBeUndefined();
  });

  // An application's own publish on a channel it shares with a session: no
  // `extras.ai` envelope, so it classifies to no event and folds nothing into
  // the Tree — while the application can still observe its own traffic via the
  // Tree's `ably-message`.
  it('passes a foreign message through to tree ably-message subscribers without folding', () => {
    const { codec } = makeCodec();
    const { tree, receiver } = createMaterialisation(codec, silentLogger);
    const raw: Ably.InboundMessage[] = [];
    const applyMessage = vi.spyOn(tree, 'applyMessage');
    tree.on('ably-message', (msg) => raw.push(msg));

    const wire = foreignWire();
    receiver.deliverEvent(wire);
    receiver.deliverAblyMessage(wire);

    expect(raw).toEqual([wire]);
    expect(applyMessage).not.toHaveBeenCalled();
  });

  describe('tree fold bracketing', () => {
    it('surfaces a tree apply throw on the error stream and suppresses the paired ably-message', () => {
      const { codec } = makeCodec();
      const { tree, receiver } = createMaterialisation(codec, silentLogger);
      const errors: Ably.ErrorInfo[] = [];
      const raw: Ably.InboundMessage[] = [];
      receiver.on('error', (err) => errors.push(err));
      tree.on('ably-message', (msg) => raw.push(msg));

      vi.spyOn(tree, 'applyMessage').mockImplementationOnce(() => {
        throw new Error('tree invariant violated');
      });
      const failing = outputMsg('s1', 'C1', 'R1');
      receiver.deliverEvent(failing);
      receiver.deliverAblyMessage(failing);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
      // The failed wire's raw emit is suppressed: subscribers never see a
      // message the Tree did not fold.
      expect(raw).toHaveLength(0);

      // The next message folds and its raw emit flows.
      const next = outputMsg('s2', 'C2', 'R2');
      receiver.deliverEvent(next);
      receiver.deliverAblyMessage(next);
      expect(tree.getRunNode('R2')).toBeDefined();
      expect(raw).toHaveLength(1);
    });

    it('does not let a failed local echo suppress an unrelated wire ably-message', () => {
      const { codec } = makeCodec();
      const { tree, receiver } = createMaterialisation(codec, silentLogger);
      const errors: Ably.ErrorInfo[] = [];
      const raw: Ably.InboundMessage[] = [];
      receiver.on('error', (err) => errors.push(err));
      tree.on('ably-message', (msg) => raw.push(msg));

      // A local echo whose fold throws: serial `undefined`, no paired raw message.
      vi.spyOn(tree, 'applyMessage').mockImplementationOnce(() => {
        throw new Error('echo fold failed');
      });
      receiver.emitEvent({
        kind: 'message',
        meta: wireMetaFromLocalEcho({}, undefined, {}),
        inputs: [{ kind: 'user-message' }],
        outputs: [],
      });
      expect(errors).toHaveLength(1);

      // The following wire is unrelated; its raw emit must not be suppressed.
      const wire = outputMsg('s1', 'C1', 'R1');
      receiver.deliverEvent(wire);
      receiver.deliverAblyMessage(wire);
      expect(raw).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// applyTransportEventToTree
// ---------------------------------------------------------------------------

interface MockTree {
  applyRunLifecycle: ReturnType<typeof vi.fn>;
  applyStepLifecycle: ReturnType<typeof vi.fn>;
  applyMessage: ReturnType<typeof vi.fn>;
}

const makeTree = (): MockTree => ({
  applyRunLifecycle: vi.fn(),
  applyStepLifecycle: vi.fn(),
  applyMessage: vi.fn(),
});

const asTree = (t: MockTree): TreeInternal<TestInput, TestOutput, TestProjection> =>
  // CAST: a minimal stub exposing only the methods the apply helper calls.
  t as unknown as TreeInternal<TestInput, TestOutput, TestProjection>;

// Narrow a classified event to non-undefined without a `!` assertion.
const classified = (
  event: TransportEvent<TestInput, TestOutput> | undefined,
): TransportEvent<TestInput, TestOutput> => {
  if (!event) throw new Error('expected a classified event, got undefined');
  return event;
};

// Wire builder pinning this section's defaults: name 'msg', serial 's1',
// timestamp 1000, `headers` -> the transport bucket.
const msg = (opts: {
  name?: string;
  headers?: Record<string, string>;
  serial?: string;
  timestamp?: number;
  version?: string;
}): Ably.InboundMessage =>
  inboundMessage({
    name: opts.name ?? 'msg',
    transport: opts.headers ?? {},
    serial: opts.serial ?? 's1',
    timestamp: opts.timestamp ?? 1000,
    versionSerial: opts.version,
  });

const makeEventDecoder = (inputs: TestInput[], outputs: TestOutput[]): Decoder<TestInput, TestOutput> => ({
  decode: vi.fn(() => ({ inputs: [...inputs], outputs: [...outputs] })),
});

// ---------------------------------------------------------------------------
// applyTransportEventToTree
// ---------------------------------------------------------------------------

describe('applyTransportEventToTree', () => {
  it('drives applyMessage off the raw transport bucket, serial, timestamp, and version', () => {
    const tree = makeTree();
    const event = classifyWireMessage(
      makeEventDecoder([], [{ type: 'out' }]),
      msg({ headers: { [HEADER_RUN_ID]: 'R1' }, serial: 's2', timestamp: 1234, version: 's2@3' }),
    );
    expect(event?.kind).toBe('message');
    applyTransportEventToTree(asTree(tree), classified(event));

    expect(tree.applyMessage).toHaveBeenCalledWith(
      { inputs: [], outputs: [{ type: 'out' }] },
      expect.objectContaining({ [HEADER_RUN_ID]: 'R1' }),
      's2',
      1234,
      's2@3',
    );
  });

  it('drives applyRunLifecycle for a run-lifecycle event', () => {
    const tree = makeTree();
    const event = classifyWireMessage(
      makeEventDecoder([], []),
      msg({ name: EVENT_RUN_START, headers: { [HEADER_RUN_ID]: 'R1' } }),
    );
    applyTransportEventToTree(asTree(tree), classified(event));

    expect(tree.applyRunLifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', runId: 'R1' }));
    expect(tree.applyMessage).not.toHaveBeenCalled();
    expect(tree.applyStepLifecycle).not.toHaveBeenCalled();
  });

  it('drives applyStepLifecycle for a step-lifecycle event', () => {
    const tree = makeTree();
    const event = classifyWireMessage(
      makeEventDecoder([], []),
      msg({
        name: EVENT_STEP_END,
        headers: { [HEADER_RUN_ID]: 'R1', [HEADER_STEP_ID]: 'S', [HEADER_STEP_START_SERIAL]: 's0' },
        serial: 's1',
      }),
    );
    applyTransportEventToTree(asTree(tree), classified(event));

    expect(tree.applyStepLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'step-end', runId: 'R1', stepId: 'S' }),
    );
    expect(tree.applyMessage).not.toHaveBeenCalled();
    expect(tree.applyRunLifecycle).not.toHaveBeenCalled();
  });
});
