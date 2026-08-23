import { describe, it, expect } from 'vitest';
import { collectGapEvents, mergeConversation, type HistorySource } from '../hydrate';
import { messageEvent, userEvent, userMessage, type Event } from './helpers';

/** A history source that serves the given batches newest-first, like the transport pages. */
function historyOf(...batches: Event[][]): HistorySource {
  let call = 0;
  return {
    history: () => {
      const events = batches[call] ?? [];
      call += 1;
      return Promise.resolve({ events, exhausted: call >= batches.length });
    },
  };
}

const startEvent = (wireId: string, domainId: string): Event =>
  messageEvent({ codecMessageId: wireId, runId: 'run-1' }, { outputs: [{ type: 'start', messageId: domainId }] });

describe('collectGapEvents', () => {
  it('pages to the channel start when nothing is stored, collecting oldest-first', async () => {
    const older = [userEvent('wire-u1', 'u1')];
    const newer = [startEvent('wire-a1', 'a1')];
    // history() returns the newest batch first; each batch is oldest-first.
    const source = historyOf(newer, older);

    const gap = await collectGapEvents(source, undefined);

    expect(gap.events).toEqual([...older, ...newer]);
    expect(gap.exhausted).toBe(true);
  });

  it('stops at the batch whose message input carries the newest stored id', async () => {
    const stored = [userEvent('wire-u1', 'u1')];
    const gap = [startEvent('wire-a1', 'a1')];
    const source = historyOf(gap, stored, [userEvent('wire-u0', 'u0')]);

    const result = await collectGapEvents(source, 'u1');

    // The batch referencing u1 is included; older pages are never requested.
    expect(result.events).toEqual([...stored, ...gap]);
    expect(result.exhausted).toBe(false);
  });

  it('stops when an output start chunk names the newest stored id', async () => {
    const stored = [startEvent('wire-a1', 'a1')];
    const gap = [userEvent('wire-u2', 'u2')];
    const source = historyOf(gap, stored, [userEvent('wire-u0', 'u0')]);

    const result = await collectGapEvents(source, 'a1');

    expect(result.events).toEqual([...stored, ...gap]);
  });

  it('stops when the wire codec-message-id equals the newest stored id', async () => {
    const stored = [messageEvent({ codecMessageId: 'm1' }, { outputs: [{ type: 'finish' }] })];
    const source = historyOf(stored, [userEvent('wire-u0', 'u0')]);

    const result = await collectGapEvents(source, 'm1');

    expect(result.events).toEqual(stored);
  });
});

describe('mergeConversation', () => {
  it('appends gap messages after the seed', async () => {
    const seed = [userMessage('u1', 'stored')];
    const gapEvents = [
      userEvent('wire-u2', 'u2'),
      messageEvent(
        { codecMessageId: 'wire-a2', runId: 'run-2' },
        {
          outputs: [
            { type: 'start', messageId: 'a2' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'live' },
            { type: 'text-end', id: 't1' },
            { type: 'finish' },
          ],
        },
      ),
    ];

    const conversation = await mergeConversation(seed, gapEvents);

    expect(conversation.map((m) => m.id)).toEqual(['u1', 'u2', 'a2']);
  });

  it('drops a gap message whose domain id the seed already holds — the seed wins', async () => {
    const seed = [userMessage('u1', 'the complete stored copy')];
    const gapEvents = [userEvent('wire-u1', 'u1'), userEvent('wire-u2', 'u2')];

    const conversation = await mergeConversation(seed, gapEvents);

    expect(conversation.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(conversation[0].parts).toEqual([{ type: 'text', text: 'the complete stored copy' }]);
  });

  it('trims partial refolds older than the seam, even under fallback ids', async () => {
    // The stopping batch can carry the tail of an older, already-stored stream
    // whose `start` chunk was never paged in: its fold falls back to the wire
    // id, which the seed does not hold. Everything folded before the seam is
    // dropped with it.
    const seed = [userMessage('u0', 'older stored'), userMessage('u1', 'seam')];
    const gapEvents = [
      // Tail of the stored older assistant's stream — no start, so it folds
      // under the wire id 'wire-a0'.
      messageEvent({ codecMessageId: 'wire-a0', runId: 'run-0' }, { outputs: [{ type: 'text-end', id: 't1' }] }),
      // The seam (the newest stored message) and the genuinely new tail.
      userEvent('wire-u1', 'u1', 'seam'),
      userEvent('wire-u2', 'u2', 'new turn'),
    ];

    const conversation = await mergeConversation(seed, gapEvents);

    expect(conversation.map((m) => m.id)).toEqual(['u0', 'u1', 'u2']);
  });

  it('returns the seed unchanged when the gap is empty', async () => {
    const seed = [userMessage('u1', 'stored')];

    expect(await mergeConversation(seed, [])).toEqual(seed);
  });
});
