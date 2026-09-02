/**
 * HistoryPager unit tests — the per-transport pager over the shared
 * `walkHistoryBatch`. The walk contract itself is pinned in
 * history-walk.test.ts; these tests cover what the pager owns: the cursor
 * opens lazily on the first call (no channel traffic before it), each call
 * returns the next older slice, concurrent calls serialise onto one cursor,
 * and a decode failure routes to `onDecodeError` without failing the batch.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { Decoder } from '../../../src/core/codec/types.js';
import { HistoryPager } from '../../../src/core/transport/history-pager.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel } from '../../helper/mock-channel.js';
import { boomMsg, outputMsg } from '../../helper/wire-messages.js';

interface TestInput {
  kind: string;
}
interface TestOutput {
  type: string;
  text?: string;
}

/**
 * A name-aware decoder: `ai-output` yields one output carrying the wire data
 * as `text`, `boom` throws, anything else decodes to nothing.
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

describe('HistoryPager', () => {
  it('opens the cursor lazily and pages one slice per call', async () => {
    const channel = createMockChannel([[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]]);
    const pager = new HistoryPager<TestInput, TestOutput>({
      channel,
      pageSize: 10,
      decoder: createDecoder(),
    });

    // Construction touches nothing — the cursor opens on the first call.
    expect(channel.history).not.toHaveBeenCalled();

    const first = await pager.next();
    expect(channel.history).toHaveBeenCalledTimes(1);
    expect(first.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['two']);
    expect(first.exhausted).toBe(false);

    const second = await pager.next();
    expect(second.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one']);
    expect(second.exhausted).toBe(true);
  });

  it('serialises concurrent calls onto the one cursor', async () => {
    const channel = createMockChannel([[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]]);
    const pager = new HistoryPager<TestInput, TestOutput>({
      channel,
      pageSize: 10,
      decoder: createDecoder(),
    });

    const [first, second] = await Promise.all([pager.next(), pager.next()]);

    // No interleaving: the first call gets the newer slice whole, the second
    // the older one.
    expect(first.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['two']);
    expect(second.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one']);
  });

  it('rejects an aborted call before opening the cursor, and stays walkable after', async () => {
    const channel = createMockChannel([[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]]);
    const pager = new HistoryPager<TestInput, TestOutput>({ channel, pageSize: 10, decoder: createDecoder() });

    await expect(pager.next({ signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
      ErrorCode.OperationCancelled,
    );
    // Checked before the attach, so an aborted call costs no page fetch — and
    // the signal is never bound to the shared cursor, which would wedge a
    // later call's `hasNext()` at false.
    expect(channel.history).not.toHaveBeenCalled();

    const batch = await pager.next();
    expect(batch.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['two']);
  });

  it('isolates a follower from the link ahead of it failing', async () => {
    const channel = createMockChannel([[outputMsg('s1', 'one')]]);
    const pager = new HistoryPager<TestInput, TestOutput>({ channel, pageSize: 10, decoder: createDecoder() });

    // The chain exists so one caller walks at a time; a link's failure is its
    // own caller's to observe, and must not reject the caller behind it.
    const failing = pager.next({ signal: AbortSignal.abort() });
    const follower = pager.next();

    await expect(failing).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    const batch = await follower;
    expect(batch.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one']);
  });

  it('routes a decode failure to onDecodeError and keeps the rest of the batch', async () => {
    const channel = createMockChannel([[outputMsg('s2', 'kept'), boomMsg('s1')]]);
    const errors: Ably.ErrorInfo[] = [];
    const pager = new HistoryPager<TestInput, TestOutput>({
      channel,
      pageSize: 10,
      decoder: createDecoder(),
      onDecodeError: (err) => errors.push(err),
    });

    const batch = await pager.next();

    expect(batch.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['kept']);
    expect(errors).toHaveLength(1);
  });
});
