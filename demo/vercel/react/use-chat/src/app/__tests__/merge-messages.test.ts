import { describe, expect, it } from 'vitest';
import { isToolUIPart, type UIMessageChunk } from 'ai';
import type { TransportEvent, WireMeta } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';
import { mergeMessages } from '../lib/merge-messages';

type VercelEvent = TransportEvent<VercelInput, VercelOutput>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let serialCounter = 0;

/** A minimal WireMeta for one wire event; only codecMessageId matters to the merge. */
function metaOf(codecMessageId: string): WireMeta {
  serialCounter += 1;
  return {
    transport: {},
    codec: {},
    headers: {},
    serial: `serial-${String(serialCounter)}`,
    codecMessageId,
    runId: undefined,
    stepId: undefined,
    stepStartSerial: undefined,
    timestamp: serialCounter,
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
  };
}

function inputEvent(codecMessageId: string, input: VercelInput): VercelEvent {
  return { kind: 'message', meta: metaOf(codecMessageId), inputs: [input], outputs: [] };
}

function outputEvent(codecMessageId: string, chunks: UIMessageChunk[]): VercelEvent {
  return { kind: 'message', meta: metaOf(codecMessageId), inputs: [], outputs: chunks };
}

/** One fanned-out user-message wire event: the whole-message envelope plus one part. */
function userPartEvent(codecMessageId: string, id: string, part: { type: 'text'; text: string }): VercelEvent {
  return inputEvent(codecMessageId, { kind: 'message', payload: { id, role: 'user', parts: [part] } });
}

const assistantTextChunks = (messageId: string, text: string): UIMessageChunk[] => [
  { type: 'start', messageId },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeMessages', () => {
  it('merges a fanned-out user message by codec-message-id and dedupes identical parts', async () => {
    const messages = await mergeMessages([
      userPartEvent('cm-1', 'u1', { type: 'text', text: 'hello' }),
      userPartEvent('cm-1', 'u1', { type: 'text', text: 'world' }),
      // A redelivered copy of the first part must not double up.
      userPartEvent('cm-1', 'u1', { type: 'text', text: 'hello' }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('u1');
    expect(messages[0].role).toBe('user');
    expect(messages[0].parts).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('merges assistant output chunks through the AI SDK reducer, keeping the last yielded message', async () => {
    const chunks = assistantTextChunks('a1', 'Hi there');
    const messages = await mergeMessages([
      // Chunks split across two wire events of the same codec message.
      outputEvent('cm-a', chunks.slice(0, 3)),
      outputEvent('cm-a', chunks.slice(3)),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].parts).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Hi there' })]));
  });

  it('orders messages by first appearance of their codec-message-id', async () => {
    const messages = await mergeMessages([
      userPartEvent('cm-u', 'u1', { type: 'text', text: 'question' }),
      outputEvent('cm-a', assistantTextChunks('a1', 'answer')),
    ]);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('appends a chunk-shaped tool resolution into the assistant bucket, resolving the tool part', async () => {
    const messages = await mergeMessages([
      outputEvent('cm-a', [
        { type: 'start', messageId: 'a1' },
        { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: { highAccuracy: false } },
        { type: 'finish' },
      ]),
      inputEvent('cm-a', {
        kind: 'chunk',
        payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { latitude: 51.5 } },
      }),
    ]);

    expect(messages).toHaveLength(1);
    const toolPart = messages[0].parts.find((part) => isToolUIPart(part));
    expect(toolPart).toBeDefined();
    expect(toolPart).toMatchObject({ state: 'output-available', output: { latitude: 51.5 } });
  });

  it('flips an approval-requested tool part to approval-responded when a decision input exists', async () => {
    const requested = await mergeMessages([
      outputEvent('cm-a', [
        { type: 'start', messageId: 'a1' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-2',
          toolName: 'getWeatherForecast',
          input: { location: 'London, UK' },
        },
        { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-2' },
        { type: 'finish' },
      ]),
      inputEvent('cm-a', {
        kind: 'approval',
        payload: { messageId: 'cm-a', toolCallId: 'call-2', approved: false, reason: 'User denied' },
      }),
    ]);

    expect(requested).toHaveLength(1);
    const toolPart = requested[0].parts.find((part) => isToolUIPart(part));
    expect(toolPart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'appr-1', approved: false, reason: 'User denied' },
    });
  });

  it('ignores regenerate inputs and events without a codec-message-id', async () => {
    const bare = metaOf('cm-x');
    const messages = await mergeMessages([
      inputEvent('cm-x', { kind: 'regenerate', payload: { messageId: 'cm-a' } }),
      { kind: 'message', meta: { ...bare, codecMessageId: undefined }, inputs: [], outputs: [] },
      {
        kind: 'run-lifecycle',
        event: { type: 'start', runId: 'r1', serial: 's', clientId: '', invocationId: '' },
      },
    ]);

    expect(messages).toEqual([]);
  });
});
