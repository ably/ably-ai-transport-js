/**
 * createMaterialisation unit tests.
 *
 * The factory pairs a fresh Tree with a WireApplier binding a fresh codec
 * decoder. Each call must produce an independent pair (a fresh Tree always gets
 * a fresh decoder), and a message folded through the applier must land in that
 * call's Tree.
 */

import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { HEADER_CODEC_MESSAGE_ID, HEADER_ROLE, HEADER_RUN_ID } from '../../../src/constants.js';
import type { Codec, CodecInputEvent, Decoder } from '../../../src/core/codec/types.js';
import { createMaterialisation } from '../../../src/core/transport/materialisation.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

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
        decode: vi.fn(() => ({ inputs: [] as TestInput[], outputs: [{ type: 'out' }] as TestOutput[] })),
      };
      decoders.push(decoder);
      return decoder;
    },
    // The remaining Codec surface is unused by these tests.
  } as unknown as Codec<TestInput, TestOutput, TestProjection, TestMessage>;
  return { codec, decoders };
};

const outputMsg = (runId: string, codecMessageId: string): Ably.InboundMessage =>
  ({
    name: 'ai-output',
    action: 'message.create',
    extras: {
      ai: {
        transport: { [HEADER_RUN_ID]: runId, [HEADER_ROLE]: 'assistant', [HEADER_CODEC_MESSAGE_ID]: codecMessageId },
      },
    },
    serial: 's1',
    timestamp: 1000,
    version: {},
  }) as unknown as Ably.InboundMessage;

describe('createMaterialisation', () => {
  it('returns a Tree and an applier that folds into that Tree', () => {
    const { codec } = makeCodec();
    const { tree, applier } = createMaterialisation(codec, silentLogger);

    applier.apply(outputMsg('R1', 'C1'));

    // The fold created the reply run in this materialisation's own Tree.
    expect(tree.getRunNode('R1')).toBeDefined();
  });

  it('creates an independent Tree and decoder on each call', () => {
    const { codec, decoders } = makeCodec();
    const first = createMaterialisation(codec, silentLogger);
    const second = createMaterialisation(codec, silentLogger);

    expect(first.tree).not.toBe(second.tree);
    expect(first.applier).not.toBe(second.applier);
    // A fresh decoder is minted per materialisation so stream-tracker state
    // can't leak across Trees.
    expect(decoders).toHaveLength(2);
    expect(decoders[0]).not.toBe(decoders[1]);

    first.applier.apply(outputMsg('R1', 'C1'));
    expect(first.tree.getRunNode('R1')).toBeDefined();
    expect(second.tree.getRunNode('R1')).toBeUndefined();
  });
});
