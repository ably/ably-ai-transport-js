/**
 * A minimal wire codec for this suite, plus the fixture stream that feeds it
 * and the assembler that reads it back.
 *
 * A transport is codec-parameterised, so any test of one needs *a* codec. A
 * provider's codec brings that provider's vocabulary with it: framing events its
 * reducer insists on, and the reducer itself to read a reply back out. On a
 * suite about Temporal, all of that is noise between the reader and the subject.
 *
 * So this codec carries the smallest thing a conversation needs. One input kind,
 * a user's prompt. One output group, a text stream. Nothing else, until a test
 * needs it.
 *
 * It is a real codec, built with `defineCodec` rather than hand-rolled. The
 * `stream(...)` descriptor is what earns that: the SDK's own encoder core turns
 * it into a create-then-append-then-close sequence on one Ably message, so a
 * test over a real channel exercises the append path rather than a fixture's
 * imitation of it. Hand-writing `WireCodec` would mean reimplementing append,
 * stream ids and status headers, and would bypass the machinery under test.
 */

import type { InputBuilder, InputDescriptor, OutputBuilder, OutputDescriptor, WireCodec } from '../../../src/index.js';
import { defineCodec, strField } from '../../../src/index.js';

/** The only input this codec carries: what a person typed. */
export interface UserPrompt {
  /** The single input kind. */
  kind: 'user-prompt';
  /** The prompt itself. */
  payload: {
    /** What the person typed. */
    text: string;
  };
}

/**
 * The output events this codec carries: one text stream, as its three phases.
 *
 * All three carry the stream's `id`, which is how the encoder knows which
 * stream a delta belongs to.
 */
export type TextChunk =
  | {
      /** Opens the text stream. */
      type: 'text-start';
      /** The stream's id. */
      id: string;
    }
  | {
      /** One fragment of the text. */
      type: 'text-delta';
      /** The stream's id. */
      id: string;
      /** The fragment to append. */
      delta: string;
    }
  | {
      /** Closes the text stream. */
      type: 'text-end';
      /** The stream's id. */
      id: string;
    };

/** Binds the stream id to its wire header, symmetrically for encode and decode. */
const fTextId = strField('id');

/**
 * Build the codec.
 *
 * A factory rather than a shared constant, so two transports in one test hold
 * independent encoder and decoder state.
 *
 * No `adapterTag`: the tag is a product attribution that lands in Ably's own
 * analytics, and there is no product here. Omitting it also means
 * `channelAgent(codec)` reports the bare SDK entry, which is the branch no
 * shipped codec exercises.
 * @returns A codec carrying a user prompt in and a text stream out.
 */
export const createTestCodec = (): WireCodec<UserPrompt, TextChunk> =>
  defineCodec<UserPrompt, TextChunk>()({
    output: ({ stream }: OutputBuilder<TextChunk>): readonly OutputDescriptor<TextChunk>[] => [
      stream('text', {
        streamId: (chunk) => chunk.id,
        fields: [fTextId],
        start: { type: 'text-start' },
        // `decode` is what puts `id` back on a rebuilt delta. Encode reads it
        // off every phase to pick the stream, but the decoder rebuilds a
        // fragment-only delta unless a group asks for fields by name — so
        // without this a decoded `text-delta` would arrive with no `id`.
        delta: { type: 'text-delta', field: 'delta', decode: ({ rebuild }) => rebuild([fTextId]) },
        end: { type: 'text-end' },
      }),
    ],
    // No `decoderSynthesiseLifecycle`: that prepends message-level lead-in
    // events for a subscriber that joined part-way through, and this codec has
    // no message envelope to synthesise. The per-stream bracket a late joiner
    // needs is rebuilt by the decoder core itself, codec-independently.
    input: ({ event }: InputBuilder<UserPrompt>): readonly InputDescriptor<UserPrompt>[] => [
      event('user-prompt', {
        data: {
          encode: (payload) => payload.text,
          // Wire data arrives as `unknown`. A prompt that is not a string
          // rebuilds as empty rather than absent, so the rebuilt payload still
          // satisfies its own type.
          decode: (data) => ({ text: typeof data === 'string' ? data : '' }),
        },
      }),
    ],
  });

/**
 * A complete text reply as a stream of this codec's outputs.
 *
 * Split into two deltas, deliberately: each one becomes its own append on the
 * wire, so a test over a real channel exercises accumulation rather than a
 * single whole-message publish.
 * @param id - The text stream's id.
 * @param text - The reply to stream.
 * @returns The output stream to hand to `run.pipe` or `step.pipe`.
 */
export const textReply = (id: string, text: string): ReadableStream<TextChunk> => {
  const mid = Math.floor(text.length / 2);
  return new ReadableStream({
    start: (controller) => {
      controller.enqueue({ type: 'text-start', id });
      controller.enqueue({ type: 'text-delta', id, delta: text.slice(0, mid) });
      controller.enqueue({ type: 'text-delta', id, delta: text.slice(mid) });
      controller.enqueue({ type: 'text-end', id });
      controller.close();
    },
  });
};

/**
 * Read a text reply back out of decoded outputs, checking the stream brackets
 * as it goes.
 *
 * The validation is the point, not decoration. Folding through a provider's own
 * reducer used to prove the sequence was well formed for free, because
 * `readUIMessageStream` throws on a delta with no opener. A bare join over the
 * deltas would assert the text and silently accept a broken bracket, so this
 * checks what the reducer used to check: every delta belongs to a stream that
 * opened, and no stream opens twice without closing.
 *
 * A re-opened stream after a close is legal and expected — a superseded step
 * attempt republishes under the same id — so a test isolates one attempt by
 * filtering on `meta.stepStartSerial` before calling this.
 * @param chunks - The decoded outputs to read, in delivery order.
 * @returns The concatenated text.
 * @throws {Error} When a delta or end arrives for a stream that is not open.
 */
export const assembleText = (chunks: TextChunk[]): string => {
  const open = new Set<string>();
  let text = '';

  for (const chunk of chunks) {
    if (chunk.type === 'text-start') {
      if (open.has(chunk.id)) throw new Error(`text stream ${chunk.id} opened twice without closing`);
      open.add(chunk.id);
      continue;
    }
    if (!open.has(chunk.id)) throw new Error(`${chunk.type} for text stream ${chunk.id}, which is not open`);
    if (chunk.type === 'text-delta') text += chunk.delta;
    else open.delete(chunk.id);
  }

  return text;
};
