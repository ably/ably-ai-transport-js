/**
 * Tests for getExistingMessages — the demo's one swappable history source:
 * it pages a transport's history to exhaustion, folds the events through the
 * shared thread fold, and reports the newest event's serial as the client's
 * hydration seam.
 */

import { describe, expect, it } from 'vitest';
import type { TransportEvent, TransportHistoryResult, WireMeta } from '@ably/ai-transport';
import type { OpenAIInput, OpenAIOutput } from '@ably/ai-transport/openai';

import { getExistingMessages, serialOf } from '../get-existing-messages';

type Event = TransportEvent<OpenAIInput, OpenAIOutput>;
type Batch = TransportHistoryResult<OpenAIInput, OpenAIOutput>;

const makeMeta = (overrides: Partial<WireMeta>): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: 's-1',
  codecMessageId: undefined,
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
  ...overrides,
});

const userEvent = (codecMessageId: string, text: string, serial: string): Event => ({
  kind: 'message',
  meta: makeMeta({ codecMessageId, role: 'user', serial }),
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

/** A history stub serving the given batches, one per call. */
const stubHistory = (batches: Batch[]): { history: () => Promise<Batch> } => ({
  history: async () => batches.shift() ?? { events: [], exhausted: true },
});

describe('getExistingMessages', () => {
  it('pages to exhaustion, folds, and reports the newest serial as the seam', async () => {
    // Two batches, newest first, each chronological within.
    const source = stubHistory([
      { events: [runStartEvent('run-1', 's-3'), userEvent('cm-2', 'second', 's-4')], exhausted: false },
      { events: [userEvent('cm-1', 'first', 's-2')], exhausted: true },
    ]);

    const existing = await getExistingMessages(source);

    expect(existing.events).toHaveLength(3);
    expect(existing.messages.map((m) => m.codecMessageId)).toEqual(['cm-1', 'cm-2']);
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
