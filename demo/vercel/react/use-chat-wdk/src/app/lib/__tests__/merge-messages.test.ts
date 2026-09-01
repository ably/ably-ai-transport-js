import type { UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';

import type { WireMeta } from '@ably/ai-transport';
import type { VercelInput } from '@ably/ai-transport/vercel';

import { mergeChunkList, mergeMessages, type WdkTransportEvent } from '../merge-messages';

let serialCounter = 0;

function meta(overrides: Partial<WireMeta> = {}): WireMeta {
  serialCounter += 1;
  const serial = `serial-${String(serialCounter).padStart(4, '0')}`;
  return {
    transport: {},
    codec: {},
    headers: {},
    serial,
    transportMessageId: undefined,
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
    inputTransportMessageId: undefined,
    inputTransportMessageIds: undefined,
    steerTransportMessageIds: undefined,
    ...overrides,
  };
}

function messageEvent(
  metaOverrides: Partial<WireMeta>,
  { inputs = [], outputs = [] }: { inputs?: VercelInput[]; outputs?: UIMessageChunk[] },
): WdkTransportEvent {
  return { kind: 'message', meta: meta(metaOverrides), inputs, outputs };
}

function userInput(id: string, text: string): VercelInput {
  return { kind: 'message', payload: { id, role: 'user', parts: [{ type: 'text', text }] } };
}

function textChunks(messageId: string, text: string): UIMessageChunk[] {
  return [
    { type: 'start', messageId },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
  ];
}

function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('mergeMessages', () => {
  it('merges a user input and an assistant output stream into two messages, in order', async () => {
    const events = [
      messageEvent({ transportMessageId: 'u1', role: 'user' }, { inputs: [userInput('m-u1', 'hello')] }),
      messageEvent(
        { transportMessageId: 'a1', role: 'assistant', stepId: 's1', stepStartSerial: '001' },
        { outputs: textChunks('m-a1', 'hi there') },
      ),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(textOf(messages[0])).toBe('hello');
    expect(messages[1].role).toBe('assistant');
    expect(textOf(messages[1])).toBe('hi there');
  });

  it('dedupes a redelivered whole-message input (last payload wins per transport-message-id)', async () => {
    const events = [
      messageEvent({ transportMessageId: 'u1' }, { inputs: [userInput('m-u1', 'hello')] }),
      messageEvent({ transportMessageId: 'u1' }, { inputs: [userInput('m-u1', 'hello')] }),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toBe('hello');
  });

  it('routes a tool output to the assistant bucket that owns the toolCallId, wherever it was published', async () => {
    const events = [
      messageEvent(
        { transportMessageId: 'a1', stepId: 's1', stepStartSerial: '001' },
        {
          outputs: [
            { type: 'start', messageId: 'm-a1' },
            {
              type: 'tool-input-available',
              toolCallId: 'call-1',
              toolName: 'getWeather',
              input: { location: 'Tokyo' },
            },
            { type: 'finish' },
          ],
        },
      ),
      // The tool activity publishes the result as its own wire message (its
      // own transport-message-id); the merge applies it onto the calling message.
      messageEvent(
        { transportMessageId: 'tool-out', stepId: 's2', stepStartSerial: '002' },
        { outputs: [{ type: 'tool-output-available', toolCallId: 'call-1', output: { temperature: 72 } }] },
      ),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(1);
    const part = messages[0].parts.find((p) => p.type === 'tool-getWeather');
    expect(part).toBeDefined();
    if (part?.type !== 'tool-getWeather') throw new Error('unexpected part');
    expect(part.state).toBe('output-available');
  });

  it('merges a client chunk input addressed to the assistant message', async () => {
    const events = [
      messageEvent(
        { transportMessageId: 'a1', stepId: 's1', stepStartSerial: '001' },
        {
          outputs: [
            { type: 'start', messageId: 'm-a1' },
            { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {} },
            { type: 'finish' },
          ],
        },
      ),
      messageEvent(
        { transportMessageId: 'a1' },
        {
          inputs: [
            {
              kind: 'chunk',
              payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { latitude: 51 } },
            },
          ],
        },
      ),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(1);
    const part = messages[0].parts.find((p) => p.type === 'tool-getLocation');
    if (part?.type !== 'tool-getLocation') throw new Error('unexpected part');
    expect(part.state).toBe('output-available');
  });

  it('applies an approval decision against the matching approval request', async () => {
    const events = [
      messageEvent(
        { transportMessageId: 'a1', stepId: 's1', stepStartSerial: '001' },
        {
          outputs: [
            { type: 'start', messageId: 'm-a1' },
            {
              type: 'tool-input-available',
              toolCallId: 'call-1',
              toolName: 'getWeatherForecast',
              input: { location: 'London' },
            },
            { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
            { type: 'finish' },
          ],
        },
      ),
      messageEvent(
        { transportMessageId: 'a1' },
        { inputs: [{ kind: 'approval', payload: { messageId: 'cm-a', toolCallId: 'call-1', approved: true } }] },
      ),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(1);
    const part = messages[0].parts.find((p) => p.type === 'tool-getWeatherForecast');
    if (part?.type !== 'tool-getWeatherForecast') throw new Error('unexpected part');
    expect(part.state).toBe('approval-responded');
    if (part.state !== 'approval-responded') throw new Error('unexpected state');
    expect(part.approval.approved).toBe(true);
    expect(part.approval.id).toBe('appr-1');
  });

  it('merges only the canonical step attempt (latest step-start-serial supersedes)', async () => {
    const events = [
      messageEvent(
        { transportMessageId: 'a1', stepId: 's1', stepStartSerial: '001' },
        { outputs: textChunks('m-dead', 'dead attempt') },
      ),
      messageEvent(
        { transportMessageId: 'a2', stepId: 's1', stepStartSerial: '002' },
        { outputs: textChunks('m-live', 'retried attempt') },
      ),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toBe('retried attempt');
  });

  it('drops an excluded step entirely, keeping everything else', async () => {
    const events = [
      messageEvent({ transportMessageId: 'u1' }, { inputs: [userInput('m-u1', 'hello')] }),
      messageEvent(
        { transportMessageId: 'a1', stepId: 's1', stepStartSerial: '001' },
        { outputs: textChunks('m-a1', 'about to be superseded') },
      ),
    ];

    const messages = await mergeMessages(events, { excludeStepId: 's1' });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('ignores run/step lifecycle events and regenerate inputs', async () => {
    const events: WdkTransportEvent[] = [
      {
        kind: 'run-lifecycle',
        event: { type: 'start', runId: 'r1', clientId: '', invocationId: '', serial: '001' },
      },
      messageEvent({ transportMessageId: 'g1' }, { inputs: [{ kind: 'regenerate', payload: { messageId: 'a1' } }] }),
    ];

    const messages = await mergeMessages(events);
    expect(messages).toHaveLength(0);
  });
});

describe('mergeChunkList', () => {
  it('reduces a chunk list to the final message state', async () => {
    const message = await mergeChunkList(textChunks('m-1', 'merged'));
    expect(message).toBeDefined();
    if (!message) throw new Error('no message');
    expect(textOf(message)).toBe('merged');
  });

  it('returns undefined for an empty chunk list with no seed', async () => {
    expect(await mergeChunkList([])).toBeUndefined();
  });
});
