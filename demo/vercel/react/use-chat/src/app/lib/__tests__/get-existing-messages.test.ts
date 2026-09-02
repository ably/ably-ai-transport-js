/**
 * Tests for getExistingMessages — the model context for one turn: the
 * conversation the store holds, with the input that woke the agent applied.
 * What is pinned here is that the two sources combine, and that nothing pages
 * channel history to get there.
 */

import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import type { LocatedInput, WireMeta } from '@ably/ai-transport';
import type { VercelInput } from '@ably/ai-transport/vercel';

import { getExistingMessages } from '../get-existing-messages';
import { loadConversation, saveMessages } from '../message-store';

const makeMeta = (transportMessageId: string): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: `s-${transportMessageId}`,
  transportMessageId,
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
});

const message = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

const locatedMessage = (transportMessageId: string, id: string, text: string): LocatedInput<VercelInput> => ({
  meta: makeMeta(transportMessageId),
  inputs: [{ kind: 'message', payload: message(id, text) }],
});

describe('getExistingMessages', () => {
  it('returns the stored conversation with the triggering input appended', async () => {
    await saveMessages('ai:context', [message('u1', 'first')]);

    const messages = await getExistingMessages('ai:context', locatedMessage('cm-2', 'u2', 'second'));

    expect(messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('returns just the triggering input for a conversation with nothing stored', async () => {
    const messages = await getExistingMessages('ai:context-fresh', locatedMessage('cm-1', 'u1', 'only'));

    expect(messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('leaves the store unchanged — the route decides when to write', async () => {
    await saveMessages('ai:context-read-only', [message('u1', 'first')]);

    await getExistingMessages('ai:context-read-only', locatedMessage('cm-2', 'u2', 'second'));

    expect(loadConversation('ai:context-read-only').messages.map((m) => m.id)).toEqual(['u1']);
  });
});
