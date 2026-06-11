import { describe, expect, it, vi } from 'vitest';

import { EVENT_AI_INPUT, HEADER_CODEC_MESSAGE_ID } from '../../../src/constants.js';
import { strField } from '../../../src/core/codec/fields.js';
import { createInputDescriptorDecoder } from '../../../src/core/codec/input-descriptor-decoder.js';
import { createInputDescriptorEncoder } from '../../../src/core/codec/input-descriptor-encoder.js';
import { inputBuilder, type InputEncoderCore } from '../../../src/core/codec/input-descriptors.js';
import type { MessagePayload, WriteOptions } from '../../../src/core/codec/types.js';
import { ErrorCode } from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// Fixture input union
//
// A small codec-shaped input union exercising every input construct:
//   - a single event (payload-nested)            → `tool-result-like`
//   - a wire-only signal                         → `signal`
//   - a multi-part batch (text / file / data-*)  → `doc`
// ---------------------------------------------------------------------------

interface ToolResultLikePayload {
  toolCallId: string;
  output: unknown;
}

type DocPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string; url: string }
  | { type: `data-${string}`; id?: string; data: unknown };

interface DocMessage {
  id: string;
  origin?: string;
  parts: DocPart[];
}

type FixtureInput =
  | { kind: 'tool-result-like'; codecMessageId: string; payload: ToolResultLikePayload }
  | { kind: 'signal' }
  | { kind: 'doc'; codecMessageId?: string; message: DocMessage };

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const fToolCallId = strField('toolCallId', '');
const fMediaType = strField('mediaType', '');
const fDataId = strField('id');

const asString = (d: unknown): string => (typeof d === 'string' ? d : '');

// ---------------------------------------------------------------------------
// Fixture descriptors — THE PROBE GATE: every author entry below must be
// cast-free (no `as` / `!`). `p` callbacks narrow to the selected part; the
// `tool-result-like` `data` callbacks see the payload, not the envelope.
// ---------------------------------------------------------------------------

const { event, batch } = inputBuilder<FixtureInput>();

const descriptors = [
  // single event — fields/data lens onto the member's payload; `p` here is the payload
  event('tool-result-like', {
    fields: [fToolCallId],
    data: {
      encode: (p) => ({ output: p.output }),
      decode: (d) => (typeof d === 'object' && d !== null && 'output' in d ? { output: d.output } : {}),
    },
  }),

  // wire-only signal — kind only, decodes to []
  event('signal', { wireOnly: true }),

  // multi-part batch — `x` narrows to the selected part in each `p(...)`;
  // `messageHeaders` stamps per-message metadata (a codec `docId`, a transport
  // `origin`) on every part, and `assemble` reconstructs it from the context.
  batch('doc', {
    explode: (input) => input.message.parts,
    partTypeOf: (part) => part.type,
    parts: (p) => [
      p('text', { data: { encode: (x) => x.text, decode: (d) => ({ text: asString(d) }) } }),
      p('file', {
        fields: [fMediaType],
        data: { encode: (x) => x.url, decode: (d) => ({ url: asString(d) }) },
      }),
      p('data-*', {
        fields: [fDataId],
        data: { encode: (x) => x.data, decode: (d) => ({ data: d }) },
      }),
    ],
    messageHeaders: (input) => ({
      codecHeaders: { docId: input.message.id },
      transportHeaders: { origin: 'client' },
    }),
    assemble: (part, { codecHeaders, transportHeaders }) => ({
      message: { id: codecHeaders.docId ?? '', origin: transportHeaders.origin ?? '', parts: [part] },
    }),
  }),
];

// ---------------------------------------------------------------------------
// Mock cores
// ---------------------------------------------------------------------------

interface MockEncodeCore extends InputEncoderCore {
  discreteCalls: { payload: MessagePayload; messageId: string | undefined }[];
  batchCalls: { payloads: MessagePayload[]; messageId: string | undefined }[];
}

const createMockCore = (): MockEncodeCore => {
  const core: MockEncodeCore = {
    discreteCalls: [],
    batchCalls: [],
    publishDiscrete: vi.fn(async (payload: MessagePayload, opts?: WriteOptions) => {
      core.discreteCalls.push({ payload, messageId: opts?.messageId });
      return await Promise.resolve({ serials: ['s'] });
    }),
    publishDiscreteBatch: vi.fn(async (payloads: MessagePayload[], opts?: WriteOptions) => {
      core.batchCalls.push({ payloads, messageId: opts?.messageId });
      return await Promise.resolve({ serials: payloads.map((_p, i) => `s${String(i)}`) });
    }),
  };
  return core;
};

const codecHeadersOf = (payload: MessagePayload): Record<string, string> => payload.codecHeaders ?? {};
const transportHeadersOf = (payload: MessagePayload): Record<string, string> => payload.transportHeaders ?? {};

/**
 * Index an array, throwing if the element is absent — keeps assertions free of
 * non-null assertions while still narrowing the element type.
 * @param arr - The array to read from.
 * @param index - The index to read.
 * @returns The element at `index`.
 */
const at = <T>(arr: readonly T[], index: number): T => {
  const item = arr[index];
  if (item === undefined) throw new Error(`expected an element at index ${String(index)}`);
  return item;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('input descriptor drivers', () => {
  const encoder = createInputDescriptorEncoder<FixtureInput>(descriptors, EVENT_AI_INPUT);
  const decoder = createInputDescriptorDecoder<FixtureInput>(descriptors);

  // -- payload-nested event ------------------------------------------------

  it('round-trips a payload-nested event and rebuilds the envelope + codecMessageId', async () => {
    const core = createMockCore();
    await encoder.encode(
      { kind: 'tool-result-like', codecMessageId: 'cm-1', payload: { toolCallId: 't1', output: { ok: true } } },
      core,
      { opts: undefined },
    );

    const { payload } = at(core.discreteCalls, 0);
    expect(codecHeadersOf(payload).kind).toBe('tool-result-like');
    // fields + data lens onto the payload
    expect(codecHeadersOf(payload).toolCallId).toBe('t1');
    expect(payload.data).toEqual({ output: { ok: true } });

    const decoded = decoder.decode({
      codecKind: 'tool-result-like',
      data: payload.data,
      codecHeaders: codecHeadersOf(payload),
      transportHeaders: { [HEADER_CODEC_MESSAGE_ID]: 'cm-1' },
    });
    expect(decoded).toEqual([
      { kind: 'tool-result-like', codecMessageId: 'cm-1', payload: { toolCallId: 't1', output: { ok: true } } },
    ]);
  });

  it('reconstructs an empty codecMessageId when the transport header is absent', async () => {
    const core = createMockCore();
    await encoder.encode(
      { kind: 'tool-result-like', codecMessageId: '', payload: { toolCallId: 't2', output: 1 } },
      core,
      { opts: undefined },
    );
    const { payload } = at(core.discreteCalls, 0);
    const decoded = decoder.decode({
      codecKind: 'tool-result-like',
      data: payload.data,
      codecHeaders: codecHeadersOf(payload),
      transportHeaders: {},
    });
    expect(decoded).toEqual([
      { kind: 'tool-result-like', codecMessageId: '', payload: { toolCallId: 't2', output: 1 } },
    ]);
  });

  // -- wire-only -----------------------------------------------------------

  it('encodes a wire-only signal as kind-only and decodes it to []', async () => {
    const core = createMockCore();
    await encoder.encode({ kind: 'signal' }, core, { opts: undefined });

    const { payload } = at(core.discreteCalls, 0);
    expect(codecHeadersOf(payload).kind).toBe('signal');
    expect(Object.keys(codecHeadersOf(payload))).toEqual(['kind']);
    expect(payload.data).toBe('');

    expect(
      decoder.decode({ codecKind: 'signal', data: '', codecHeaders: { kind: 'signal' }, transportHeaders: {} }),
    ).toEqual([]);
  });

  // -- batch fan-out / fan-in ----------------------------------------------

  it('fans a multi-part message out and back in', async () => {
    const core = createMockCore();
    await encoder.encode(
      {
        kind: 'doc',
        codecMessageId: 'cm-doc',
        message: {
          id: 'm1',
          parts: [
            { type: 'text', text: 'hello' },
            { type: 'file', mediaType: 'image/png', url: 'https://x/y.png' },
            { type: 'data-foo', id: 'd1', data: { n: 7 } },
          ],
        },
      },
      core,
      { opts: undefined },
    );

    expect(core.batchCalls).toHaveLength(1);
    const { payloads } = at(core.batchCalls, 0);
    expect(payloads).toHaveLength(3);

    // text part — per-message headers (docId codec, origin transport) ride every part
    expect(codecHeadersOf(at(payloads, 0)).kind).toBe('doc');
    expect(codecHeadersOf(at(payloads, 0)).partType).toBe('text');
    expect(codecHeadersOf(at(payloads, 0)).docId).toBe('m1');
    expect(transportHeadersOf(at(payloads, 0)).origin).toBe('client');
    expect(at(payloads, 0).data).toBe('hello');
    // file part
    expect(codecHeadersOf(at(payloads, 1)).partType).toBe('file');
    expect(codecHeadersOf(at(payloads, 1)).mediaType).toBe('image/png');
    expect(at(payloads, 1).data).toBe('https://x/y.png');
    // data-* wildcard part
    expect(codecHeadersOf(at(payloads, 2)).partType).toBe('data-foo');
    expect(codecHeadersOf(at(payloads, 2)).id).toBe('d1');
    expect(at(payloads, 2).data).toEqual({ n: 7 });

    // each part decodes back to a one-part input; the driver stamps `kind` (a batch is
    // not codec-message-id-addressed), and `assemble` reconstructs the message id + origin
    // from the per-message headers
    const decodedText = decoder.decode({
      codecKind: 'doc',
      data: at(payloads, 0).data,
      codecHeaders: codecHeadersOf(at(payloads, 0)),
      transportHeaders: transportHeadersOf(at(payloads, 0)),
    });
    expect(decodedText).toEqual([
      {
        kind: 'doc',
        message: { id: 'm1', origin: 'client', parts: [{ type: 'text', text: 'hello' }] },
      },
    ]);

    const decodedData = decoder.decode({
      codecKind: 'doc',
      data: at(payloads, 2).data,
      codecHeaders: codecHeadersOf(at(payloads, 2)),
      transportHeaders: transportHeadersOf(at(payloads, 2)),
    });
    expect(decodedData).toEqual([
      {
        kind: 'doc',
        message: { id: 'm1', origin: 'client', parts: [{ type: 'data-foo', id: 'd1', data: { n: 7 } }] },
      },
    ]);
  });

  it('guarantees at least one wire event when explode yields nothing', async () => {
    const core = createMockCore();
    await encoder.encode({ kind: 'doc', codecMessageId: 'cm-empty', message: { id: 'm0', parts: [] } }, core, {
      opts: undefined,
    });

    expect(core.batchCalls).toHaveLength(1);
    const { payloads } = at(core.batchCalls, 0);
    expect(payloads).toHaveLength(1);
    // The bare fallback part still carries the shared per-message headers so the
    // message id and origin survive an empty decomposition.
    expect(codecHeadersOf(at(payloads, 0)).kind).toBe('doc');
    expect(codecHeadersOf(at(payloads, 0)).docId).toBe('m0');
    expect(transportHeadersOf(at(payloads, 0)).origin).toBe('client');
  });

  // -- wire robustness -------------------------------------------------------

  it('drops a batch wire event whose partType header is absent or empty', () => {
    // The driver's bare fallback (and any foreign message) carries no partType;
    // neither an exact part nor the wildcard's derived predicate may match it.
    const headerVariants: Record<string, string>[] = [
      { kind: 'doc', docId: 'm0' },
      { kind: 'doc', docId: 'm0', partType: '' },
    ];
    for (const codecHeaders of headerVariants) {
      const decoded = decoder.decode({ codecKind: 'doc', data: '', codecHeaders, transportHeaders: {} });
      expect(decoded).toEqual([]);
    }
  });

  it('rejects encoding a payload-less event that is not wireOnly', async () => {
    // `signal` has no payload: with neither `wireOnly: true` nor an encode
    // hatch the driver has nothing to publish — fail fast instead of putting
    // an empty, undecodable event on the wire.
    const { event: bareEvent } = inputBuilder<FixtureInput>();
    const badEncoder = createInputDescriptorEncoder<FixtureInput>([bareEvent('signal')], EVENT_AI_INPUT);
    const core = createMockCore();

    await expect(badEncoder.encode({ kind: 'signal' }, core, { opts: undefined })).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
    expect(core.discreteCalls).toHaveLength(0);
  });

  it('strips decode-contributed undefined props from the rebuilt payload', () => {
    const [decoded] = decoder.decode({
      codecKind: 'tool-result-like',
      data: { output: undefined },
      codecHeaders: { kind: 'tool-result-like', toolCallId: 't9' },
      transportHeaders: { [HEADER_CODEC_MESSAGE_ID]: 'cm-9' },
    });
    if (decoded?.kind !== 'tool-result-like') throw new Error('expected a tool-result-like input');
    // Absent and undefined are indistinguishable on the wire; the rebuild seam
    // strips undefined so the payload carries only defined props.
    expect('output' in decoded.payload).toBe(false);
    expect(decoded.payload.toolCallId).toBe('t9');
  });
});
