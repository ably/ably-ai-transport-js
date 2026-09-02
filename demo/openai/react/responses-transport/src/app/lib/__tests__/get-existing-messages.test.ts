/**
 * Tests for the demo's channel readers: `getExistingMessages`, which pages a
 * transport's history to exhaustion and merges it into the agent's model
 * context, and `seedableEvents`, which decides what a client may store for a
 * later client to seed from.
 */

import { describe, expect, it } from 'vitest';
import type { TransportEvent, TransportHistoryResult, WireMeta } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIInput } from '../openai-thread';

import { getExistingMessages, seedableEvents, serialOf } from '../get-existing-messages';

type Event = TransportEvent<OpenAIInput, OpenAIOutput>;
type Batch = TransportHistoryResult<OpenAIInput, OpenAIOutput>;

const makeMeta = (overrides: Partial<WireMeta>): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: 's-1',
  transportMessageId: undefined,
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: 1,
  role: undefined,
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  inputTransportMessageId: undefined,
  inputTransportMessageIds: undefined,
  steerTransportMessageIds: undefined,
  ...overrides,
});

const userEvent = (transportMessageId: string, text: string, serial: string): Event => ({
  kind: 'message',
  meta: makeMeta({ transportMessageId, role: 'user', serial }),
  inputs: [
    {
      kind: 'message',
      payload: { role: 'user', items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] },
    },
  ],
  outputs: [],
});

const runStartEvent = (runId: string, serial: string): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'start', runId, clientId: 'agent', invocationId: 'inv-1', serial },
});

const runEndEvent = (runId: string, serial: string): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'end', runId, clientId: 'agent', invocationId: 'inv-1', serial, reason: 'complete' },
});

const assistantEvent = (transportMessageId: string, runId: string, serial: string): Event => ({
  kind: 'message',
  meta: makeMeta({ transportMessageId, role: 'assistant', runId, serial }),
  inputs: [],
  outputs: [],
});

/** A history stub serving the given batches, one per call. */
const stubHistory = (batches: Batch[]): { history: () => Promise<Batch> } => ({
  history: async () => batches.shift() ?? { events: [], exhausted: true },
});

describe('getExistingMessages', () => {
  it('pages to exhaustion, merges, and reports the newest serial as the seam', async () => {
    // Two batches, newest first, each chronological within.
    const source = stubHistory([
      { events: [runStartEvent('run-1', 's-3'), userEvent('cm-2', 'second', 's-4')], exhausted: false },
      { events: [userEvent('cm-1', 'first', 's-2')], exhausted: true },
    ]);

    const existing = await getExistingMessages(source);

    expect(existing.events).toHaveLength(3);
    expect(existing.messages.map((m) => m.transportMessageId)).toEqual(['cm-1', 'cm-2']);
    expect(existing.latestSerial).toBe('s-4');
  });

  it('reports an undefined seam for an empty conversation', async () => {
    const existing = await getExistingMessages(stubHistory([{ events: [], exhausted: true }]));

    expect(existing.events).toEqual([]);
    expect(existing.messages).toEqual([]);
    expect(existing.latestSerial).toBeUndefined();
  });
});

describe('serialOf', () => {
  it('reads a message event wire serial and a lifecycle event own serial', () => {
    expect(serialOf(userEvent('cm-1', 'hi', 's-9'))).toBe('s-9');
    expect(serialOf(runStartEvent('run-1', 's-8'))).toBe('s-8');
  });
});

describe('seedableEvents', () => {
  it('keeps an ended run and the events with no run of their own', () => {
    const events = [
      userEvent('cm-u1', 'prompt', 's-1'),
      runStartEvent('run-1', 's-2'),
      assistantEvent('cm-a1', 'run-1', 's-3'),
      runEndEvent('run-1', 's-4'),
    ];

    const seedable = seedableEvents(events);

    expect(seedable.events).toEqual(events);
    expect(seedable.latestSerial).toBe('s-4');
  });

  it('withholds a run that has not ended and moves the watermark back past it', () => {
    const stored = [
      userEvent('cm-u1', 'prompt', 's-1'),
      runStartEvent('run-1', 's-2'),
      assistantEvent('cm-a1', 'run-1', 's-3'),
      runEndEvent('run-1', 's-4'),
    ];
    // A second run is still streaming: its start and its output so far must
    // not be stored, and the watermark must stay behind them so the next
    // client's gap walk picks the whole run up.
    const events = [...stored, runStartEvent('run-2', 's-5'), assistantEvent('cm-a2', 'run-2', 's-6')];

    const seedable = seedableEvents(events);

    expect(seedable.events).toEqual(stored);
    expect(seedable.latestSerial).toBe('s-4');
  });

  it('withholds a suspended run, which has paused rather than ended', () => {
    const events = [
      runStartEvent('run-1', 's-1'),
      assistantEvent('cm-a1', 'run-1', 's-2'),
      {
        kind: 'run-lifecycle',
        event: { type: 'suspend', runId: 'run-1', clientId: 'agent', invocationId: 'inv-1', serial: 's-3' },
      } satisfies Event,
    ];

    const seedable = seedableEvents(events);

    expect(seedable.events).toEqual([]);
    expect(seedable.latestSerial).toBeUndefined();
  });

  it('reports an undefined watermark for an empty conversation', () => {
    expect(seedableEvents([])).toEqual({ events: [], latestSerial: undefined });
  });
});
