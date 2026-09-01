import { describe, it, expect } from 'vitest';
import { isDynamicToolUIPart, isToolUIPart, type UIMessage } from 'ai';
import { foldMessages } from '../fold-messages';
import { messageEvent, runEndEvent, userEvent, userMessage } from './helpers';

/** The single tool part on a folded assistant message. */
function toolPart(message: UIMessage) {
  const part = message.parts.find((p) => isToolUIPart(p) || isDynamicToolUIPart(p));
  if (!part) throw new Error('expected a tool part');
  return part;
}

describe('foldMessages', () => {
  it('folds a user input and a streamed assistant reply into two messages', async () => {
    const events = [
      userEvent('wire-u1', 'u1'),
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'hello' },
            { type: 'text-delta', id: 't1', delta: ' there' },
            { type: 'text-end', id: 't1' },
            { type: 'finish' },
          ],
        },
      ),
    ];

    const messages = await foldMessages(events);

    expect(messages.map((entry) => ({ codecMessageId: entry.codecMessageId, id: entry.message.id }))).toEqual([
      { codecMessageId: 'wire-u1', id: 'u1' },
      { codecMessageId: 'wire-a1', id: 'a1' },
    ]);
    expect(messages[1].message.role).toBe('assistant');
    expect(messages[1].message.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'hello there' }));
  });

  it('routes chunks to their message by the wire codec-message-id', async () => {
    const events = [
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'first' },
          ],
        },
      ),
      messageEvent(
        { codecMessageId: 'wire-a2', runId: 'run-2' },
        {
          outputs: [
            { type: 'start', messageId: 'a2' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'second' },
          ],
        },
      ),
      messageEvent({ codecMessageId: 'wire-a1', runId: 'run-1' }, { outputs: [{ type: 'text-end', id: 't1' }] }),
    ];

    const messages = await foldMessages(events);

    expect(messages.map((entry) => entry.message.id)).toEqual(['a1', 'a2']);
    expect(messages[0].message.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'first' }));
    expect(messages[1].message.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'second' }));
  });

  it('falls back to the codec-message-id as the domain id when no start names one', async () => {
    const events = [
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'start' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'anon' },
            { type: 'text-end', id: 't1' },
          ],
        },
      ),
    ];

    const messages = await foldMessages(events);

    expect(messages[0].message.id).toBe('wire-a1');
  });

  it('merges wire-fanned message parts by codec-message-id and dedupes the echo pair', async () => {
    const events = [
      // The wire fans one part out per event; an optimistic echo repeats the
      // first part verbatim.
      messageEvent(
        { codecMessageId: 'wire-u1', serial: undefined },
        { inputs: [{ kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] } }] },
      ),
      messageEvent(
        { codecMessageId: 'wire-u1' },
        { inputs: [{ kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] } }] },
      ),
      messageEvent(
        { codecMessageId: 'wire-u1' },
        { inputs: [{ kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'two' }] } }] },
      ),
    ];

    const messages = await foldMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0].message.id).toBe('u1');
    expect(messages[0].message.parts).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('applies a chunk-kind input (a client tool resolution) to the assistant it addresses', async () => {
    const events = [
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getLocation' },
            { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'getLocation', input: {} },
          ],
        },
      ),
      // The client publishes the resolution addressed to the assistant's wire id.
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          inputs: [
            { kind: 'chunk', payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { lat: 51.5 } } },
          ],
        },
      ),
    ];

    const messages = await foldMessages(events);

    expect(messages).toHaveLength(1);
    const part = toolPart(messages[0].message);
    expect(part.state).toBe('output-available');
    expect(part.output).toEqual({ lat: 51.5 });
  });

  it('routes a tool-output chunk streamed under a fresh codec-message-id to the calling message', async () => {
    const events = [
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getWeatherForecast' },
            {
              type: 'tool-input-available',
              toolCallId: 'call-1',
              toolName: 'getWeatherForecast',
              input: { location: 'London' },
            },
          ],
        },
      ),
      // The resumed run streams the execution's output under a new wire id.
      messageEvent(
        { codecMessageId: 'wire-a2', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a2' },
            { type: 'tool-output-available', toolCallId: 'call-1', output: { forecast: 'sunny' } },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Here is the forecast.' },
            { type: 'text-end', id: 't1' },
          ],
        },
      ),
    ];

    const messages = await foldMessages(events);

    expect(messages.map((entry) => entry.message.id)).toEqual(['a1', 'a2']);
    const part = toolPart(messages[0].message);
    expect(part.state).toBe('output-available');
    expect(part.output).toEqual({ forecast: 'sunny' });
    expect(messages[1].message.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Here is the forecast.' }),
    );
  });

  it('flips an approval-requested tool part to approval-responded on an approval input', async () => {
    const stream = messageEvent(
      { codecMessageId: 'wire-a1', runId: 'run-1' },
      {
        outputs: [
          { type: 'start', messageId: 'a1' },
          { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getWeatherForecast' },
          {
            type: 'tool-input-available',
            toolCallId: 'call-1',
            toolName: 'getWeatherForecast',
            input: { location: 'London' },
          },
          { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'call-1' },
        ],
      },
    );

    const approved = await foldMessages([
      stream,
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        { inputs: [{ kind: 'approval', payload: { messageId: 'cm-a', toolCallId: 'call-1', approved: true } }] },
      ),
    ]);
    const approvedPart = toolPart(approved[0].message);
    expect(approvedPart.state).toBe('approval-responded');
    expect(approvedPart.approval).toEqual(expect.objectContaining({ id: 'ap-1', approved: true }));

    const denied = await foldMessages([
      stream,
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          inputs: [
            {
              kind: 'approval',
              payload: { messageId: 'cm-a', toolCallId: 'call-1', approved: false, reason: 'User denied' },
            },
          ],
        },
      ),
    ]);
    const deniedPart = toolPart(denied[0].message);
    expect(deniedPart.state).toBe('approval-responded');
    expect(deniedPart.approval).toEqual(
      expect.objectContaining({ id: 'ap-1', approved: false, reason: 'User denied' }),
    );
  });

  it('leaves a resolved tool part alone when an approval input arrives after the output', async () => {
    const events = [
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a1' },
            { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'getWeatherForecast' },
            {
              type: 'tool-input-available',
              toolCallId: 'call-1',
              toolName: 'getWeatherForecast',
              input: { location: 'London' },
            },
            { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'call-1' },
          ],
        },
      ),
      messageEvent(
        { codecMessageId: 'wire-a1', runId: 'run-1' },
        { inputs: [{ kind: 'approval', payload: { messageId: 'cm-a', toolCallId: 'call-1', approved: true } }] },
      ),
      messageEvent(
        { codecMessageId: 'wire-a2', runId: 'run-1' },
        {
          outputs: [
            { type: 'start', messageId: 'a2' },
            { type: 'tool-output-available', toolCallId: 'call-1', output: { forecast: 'sunny' } },
          ],
        },
      ),
    ];

    const messages = await foldMessages(events);

    expect(toolPart(messages[0].message).state).toBe('output-available');
  });

  it('ignores lifecycle events and message events with no codec-message-id', async () => {
    const messages = await foldMessages([
      runEndEvent('run-1'),
      messageEvent({}, { inputs: [{ kind: 'message', payload: userMessage('u1', 'orphan') }] }),
    ]);

    expect(messages).toEqual([]);
  });
});
