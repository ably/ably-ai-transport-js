/**
 * Tests for the demo's in-memory conversation store: it saves a channel's
 * decoded events with the serial they run up to, replaces a conversation
 * wholesale on the next save, and ignores a save whose watermark has gone
 * backwards.
 *
 * The store is module-scoped, so each test uses its own channel name.
 */

import { describe, expect, it } from 'vitest';
import type { TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIInput } from '../openai-thread';
import { loadConversation, saveConversation } from '../message-store';

type Event = TransportEvent<OpenAIInput, OpenAIOutput>;

const runStart = (runId: string, serial: string): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'start', runId, clientId: 'agent', invocationId: 'inv-1', serial },
});

describe('message store', () => {
  it('reports an empty conversation for a channel it has never seen', () => {
    const stored = loadConversation('ai:unknown');

    expect(stored.events).toEqual([]);
    expect(stored.latestSerial).toBeUndefined();
  });

  it('saves the events and the serial they run up to', async () => {
    const events = [runStart('run-1', 's-1')];

    await saveConversation('ai:saved', events, 's-1');

    expect(loadConversation('ai:saved')).toEqual({ events, latestSerial: 's-1' });
  });

  it('replaces the conversation wholesale on the next save', async () => {
    await saveConversation('ai:replaced', [runStart('run-1', 's-1')], 's-1');
    const later = [runStart('run-1', 's-1'), runStart('run-2', 's-2')];

    await saveConversation('ai:replaced', later, 's-2');

    expect(loadConversation('ai:replaced')).toEqual({ events: later, latestSerial: 's-2' });
  });

  it('ignores a save whose watermark is older than the stored one', async () => {
    const held = [runStart('run-1', 's-1'), runStart('run-2', 's-2')];
    await saveConversation('ai:stale', held, 's-2');

    await saveConversation('ai:stale', [runStart('run-1', 's-1')], 's-1');

    expect(loadConversation('ai:stale')).toEqual({ events: held, latestSerial: 's-2' });
  });

  it('ignores a save carrying no watermark once one is stored', async () => {
    const held = [runStart('run-1', 's-1')];
    await saveConversation('ai:no-watermark', held, 's-1');

    await saveConversation('ai:no-watermark', []);

    expect(loadConversation('ai:no-watermark')).toEqual({ events: held, latestSerial: 's-1' });
  });

  it('accepts a save at the same watermark, which is how a re-save lands', async () => {
    await saveConversation('ai:resave', [runStart('run-1', 's-1')], 's-1');
    const again = [runStart('run-1', 's-1')];

    await saveConversation('ai:resave', again, 's-1');

    expect(loadConversation('ai:resave').events).toBe(again);
  });
});
