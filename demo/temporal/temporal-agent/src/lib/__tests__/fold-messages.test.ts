/**
 * Tests for the demo's message fold: transport events in, `UIMessage[]` out.
 * Covers the four input shapes the fold handles — output chunks, whole-message
 * inputs (with echo dedupe), chunk-shaped tool resolutions, and approval
 * decisions — plus first-seen message ordering.
 */

import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import type { WireMeta } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

import { foldMessages, type VercelTransportEvent } from '../fold-messages';

/** A complete WireMeta stub carrying only the codec-message-id the fold reads. */
const meta = (codecMessageId: string): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: undefined,
  codecMessageId,
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: undefined,
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

const messageEvent = (
  codecMessageId: string,
  parts: { inputs?: VercelInput[]; outputs?: VercelOutput[] },
): VercelTransportEvent => ({
  kind: 'message',
  meta: meta(codecMessageId),
  inputs: parts.inputs ?? [],
  outputs: parts.outputs ?? [],
});

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/** Assistant output chunks streaming one text reply. */
const textChunks = (messageId: string, text: string): VercelOutput[] => [
  { type: 'start', messageId },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

/** Assistant output chunks streaming one pending tool call. */
const toolCallChunks = (messageId: string, toolCallId: string, toolName: string): VercelOutput[] => [
  { type: 'start', messageId },
  { type: 'tool-input-available', toolCallId, toolName, input: { location: 'Paris' } },
  { type: 'finish' },
];

describe('foldMessages', () => {
  it('folds output chunks into an assistant message via the AI SDK reducer', async () => {
    const messages = await foldMessages([messageEvent('cm-1', { outputs: textChunks('a1', 'Hello there') })]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello there' }));
  });

  it('passes a whole-message input through and dedupes its optimistic/wire echo pair', async () => {
    const message = userMessage('u1', 'hi');
    const messages = await foldMessages([
      // Optimistic local echo, then the wire echo of the same publish.
      messageEvent('cm-1', { inputs: [{ kind: 'message', payload: message }] }),
      messageEvent('cm-1', { inputs: [{ kind: 'message', payload: structuredClone(message) }] }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('folds a chunk-shaped tool resolution onto the assistant bucket', async () => {
    const messages = await foldMessages([
      messageEvent('cm-1', { outputs: toolCallChunks('a1', 'call-1', 'getLocation') }),
      messageEvent('cm-1', {
        inputs: [
          { kind: 'chunk', payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { lat: 1 } } },
        ],
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toContainEqual(
      expect.objectContaining({ toolCallId: 'call-1', state: 'output-available', output: { lat: 1 } }),
    );
  });

  it('flips the matching tool part on an approval decision', async () => {
    const messages = await foldMessages([
      messageEvent('cm-1', {
        outputs: [
          { type: 'start', messageId: 'a1' },
          { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getWeatherForecast', input: {} },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
          { type: 'finish' },
        ],
      }),
      messageEvent('cm-1', {
        inputs: [{ kind: 'approval', payload: { toolCallId: 'call-1', approved: true, reason: 'go ahead' } }],
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toContainEqual(
      expect.objectContaining({
        toolCallId: 'call-1',
        state: 'approval-responded',
        approval: { id: 'appr-1', approved: true, reason: 'go ahead' },
      }),
    );
  });

  it('orders messages by first-seen codec-message-id', async () => {
    const messages = await foldMessages([
      messageEvent('cm-user', { inputs: [{ kind: 'message', payload: userMessage('u1', 'question') }] }),
      messageEvent('cm-assistant', { outputs: textChunks('a1', 'answer') }),
      // A late fragment for the user message must not reorder it.
      messageEvent('cm-user', { inputs: [{ kind: 'message', payload: userMessage('u1', 'question') }] }),
    ]);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('ignores events with no codec-message-id and empty buckets', async () => {
    const messages = await foldMessages([
      { kind: 'message', meta: { ...meta('cm-1'), codecMessageId: undefined }, inputs: [], outputs: [] },
      messageEvent('cm-2', { inputs: [{ kind: 'regenerate' }] }),
    ]);

    expect(messages).toEqual([]);
  });
});
