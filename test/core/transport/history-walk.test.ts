/**
 * Unit tests for the shared `walkHistoryBatch` primitive.
 *
 * `walkHistoryBatch` is the history batch walk behind both transports'
 * `history()`: it pages a caller-owned `HistoryPagesCursor` newest-first,
 * classifies each page's wires in chronological order on the caller's decoder,
 * and reverses the page order at the end so the returned batch is
 * chronological throughout. These tests pin the walk contract independently of
 * either transport:
 *
 *  - the whole history folds into one chronological batch; `exhausted`
 *    mirrors `cursor.hasNext()`
 *  - `limit` pauses at page granularity; another walk on the same cursor
 *    resumes with the remainder
 *  - an already-aborted signal throws `OperationCancelled` before any page
 *    is fetched
 *  - an undecodable message is wrapped, handed to `onDecodeError`, and
 *    skipped without failing the batch
 *  - a wire-only carrier (empty decode, no run-id) is filtered from the batch
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { Decoder } from '../../../src/core/codec/types.js';
import { walkHistoryBatch } from '../../../src/core/transport/history-walk.js';
import type { TransportEvent } from '../../../src/core/transport/types/transport.js';
import { ErrorCode } from '../../../src/errors.js';
import { makeHistoryCursor } from '../../helper/history-cursor.js';
import { boomMsg, inboundMessage, outputMsg } from '../../helper/wire-messages.js';

interface TestInput {
  kind: string;
}
interface TestOutput {
  type: string;
  text?: string;
}

/**
 * A name-aware decoder like the transports use: `ai-output` yields one output
 * carrying the wire data as `text`, `boom` throws, anything else decodes to
 * nothing.
 * @returns The decoder.
 */
const createDecoder = (): Decoder<TestInput, TestOutput> => ({
  decode: (msg: Ably.InboundMessage): { inputs: TestInput[]; outputs: TestOutput[] } => {
    if (msg.name === 'boom') throw new Error('malformed payload');
    if (msg.name === 'ai-output') {
      // CAST: the test wires carry string data.
      return { inputs: [], outputs: [{ type: 'out', text: msg.data as string }] };
    }
    return { inputs: [], outputs: [] };
  },
});

/**
 * Project a batch onto its output texts, in batch order.
 * @param events - The classified batch.
 * @returns One text per event (`undefined` for a non-message event).
 */
const texts = (events: TransportEvent<TestInput, TestOutput>[]): (string | undefined)[] =>
  events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined));

describe('walkHistoryBatch', () => {
  it('returns the whole history as one chronological batch and reports exhaustion', async () => {
    // Two pages, newest page first, newest-first within each page.
    const cursor = makeHistoryCursor([
      [outputMsg('s4', 'four'), outputMsg('s3', 'three')],
      [outputMsg('s2', 'two'), outputMsg('s1', 'one')],
    ]);

    const result = await walkHistoryBatch({ cursor, decoder: createDecoder() }, {});

    expect(texts(result.events)).toEqual(['one', 'two', 'three', 'four']);
    expect(result.exhausted).toBe(true);
    expect(cursor.nextCalls()).toBe(2);
  });

  it('pauses at the limit (page granular); the same cursor resumes with the remainder', async () => {
    const cursor = makeHistoryCursor([
      [outputMsg('s4', 'four'), outputMsg('s3', 'three')],
      [outputMsg('s2', 'two'), outputMsg('s1', 'one')],
    ]);
    const decoder = createDecoder();

    const first = await walkHistoryBatch({ cursor, decoder }, { limit: 1 });
    // One page satisfied the limit; the batch is that page, chronological.
    expect(texts(first.events)).toEqual(['three', 'four']);
    expect(first.exhausted).toBe(false);
    expect(cursor.nextCalls()).toBe(1);

    const second = await walkHistoryBatch({ cursor, decoder }, {});
    expect(texts(second.events)).toEqual(['one', 'two']);
    expect(second.exhausted).toBe(true);
  });

  it('throws OperationCancelled for an already-aborted signal without consuming the cursor', async () => {
    const cursor = makeHistoryCursor([[outputMsg('s1', 'one')]]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      walkHistoryBatch({ cursor, decoder: createDecoder() }, { signal: controller.signal }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    expect(cursor.nextCalls()).toBe(0);
  });

  it('skips an undecodable message onto onDecodeError and keeps the rest of the batch', async () => {
    const cursor = makeHistoryCursor([[outputMsg('s3', 'kept'), boomMsg('s2'), outputMsg('s1', 'also-kept')]]);
    const errors: Ably.ErrorInfo[] = [];

    const result = await walkHistoryBatch(
      { cursor, decoder: createDecoder(), onDecodeError: (err) => errors.push(err) },
      {},
    );

    expect(texts(result.events)).toEqual(['also-kept', 'kept']);
    expect(result.exhausted).toBe(true);
    expect(errors).toHaveLength(1);
    // The decoder throw arrives wrapped as the shared message-processing error.
    expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
  });

  it('filters a wire-only carrier from the batch', async () => {
    // The carrier decodes to nothing and names no run-id, so classification
    // filters it.
    const carrier = inboundMessage({ name: 'noise', serial: 's1', timestamp: 1000 });
    const cursor = makeHistoryCursor([[outputMsg('s2', 'kept'), carrier]]);

    const result = await walkHistoryBatch({ cursor, decoder: createDecoder() }, {});

    expect(texts(result.events)).toEqual(['kept']);
    expect(result.exhausted).toBe(true);
  });
});
