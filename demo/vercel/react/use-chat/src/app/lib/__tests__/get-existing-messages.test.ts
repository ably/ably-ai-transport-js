/**
 * Tests for getExistingMessages — the demo's swappable history source: it
 * pages a transport's history to exhaustion and merges the events through the
 * demo's merge helper. Swapping the channel for a database later means
 * reimplementing only this function, so what is pinned here is its contract:
 * every batch is paged, and batches arrive newest-first but merge oldest-first.
 */

import { describe, expect, it } from 'vitest';
import type { TransportEvent, TransportHistoryResult, WireMeta } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

import { getExistingMessages } from '../get-existing-messages';

type Event = TransportEvent<VercelInput, VercelOutput>;
type Batch = TransportHistoryResult<VercelInput, VercelOutput>;

const makeMeta = (codecMessageId: string): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: `s-${codecMessageId}`,
  codecMessageId,
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: 1,
  role: undefined,
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  parent: undefined,
  forkOf: undefined,
  regenerates: undefined,
  inputCodecMessageId: undefined,
  inputCodecMessageIds: undefined,
  steerCodecMessageIds: undefined,
});

const userEvent = (codecMessageId: string, id: string, text: string): Event => ({
  kind: 'message',
  meta: makeMeta(codecMessageId),
  inputs: [{ kind: 'message', payload: { id, role: 'user', parts: [{ type: 'text', text }] } }],
  outputs: [],
});

/** A transport stub serving scripted batches newest-first, as `history()` does. */
const stubTransport = (batches: Batch[]) => {
  let call = 0;
  return {
    calls: () => call,
    history: async (): Promise<Batch> => {
      const batch = batches[call] ?? { events: [], exhausted: true };
      call += 1;
      return batch;
    },
  };
};

describe('getExistingMessages', () => {
  it('pages every batch and merges them oldest-first', async () => {
    // history() walks backwards, so the newest batch comes first.
    const transport = stubTransport([
      { events: [userEvent('cm-2', 'u2', 'second')], exhausted: false },
      { events: [userEvent('cm-1', 'u1', 'first')], exhausted: true },
    ]);

    const messages = await getExistingMessages(transport);

    expect(transport.calls()).toBe(2);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('stops at the first exhausted batch', async () => {
    const transport = stubTransport([{ events: [userEvent('cm-1', 'u1', 'only')], exhausted: true }]);

    const messages = await getExistingMessages(transport);

    expect(transport.calls()).toBe(1);
    expect(messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('returns nothing for an empty channel', async () => {
    const transport = stubTransport([{ events: [], exhausted: true }]);

    await expect(getExistingMessages(transport)).resolves.toEqual([]);
  });
});
