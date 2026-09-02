/**
 * Tests for applyInputs — the update the agent makes to the stored
 * conversation from the one input that woke it: a user turn, a client's tool
 * resolution, or an approval decision.
 */

import { describe, expect, it } from 'vitest';
import { isToolUIPart, type UIMessage } from 'ai';
import type { VercelInput } from '@ably/ai-transport/vercel';

import { applyInputs } from '../apply-input';

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

/** An assistant message holding an unresolved client tool call. */
const assistantWithCall = (id: string, toolCallId: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    {
      type: 'tool-getLocation',
      toolCallId,
      state: 'input-available',
      input: { highAccuracy: false },
    },
  ],
});

/** An assistant message whose tool call is waiting on an approval decision. */
const assistantAwaitingApproval = (id: string, toolCallId: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    {
      type: 'tool-getWeatherForecast',
      toolCallId,
      state: 'approval-requested',
      input: { location: 'London, UK' },
      approval: { id: 'appr-1' },
    },
  ],
});

const messageInput = (message: UIMessage): VercelInput => ({ kind: 'message', payload: message });

describe('applyInputs', () => {
  it('appends a user turn the conversation has not seen', async () => {
    const stored = [userMessage('u1', 'first')];

    const messages = await applyInputs(stored, [messageInput(userMessage('u2', 'second'))]);

    expect(messages.map((message) => message.id)).toEqual(['u1', 'u2']);
  });

  it('replaces a message of the same id rather than duplicating it', async () => {
    const stored = [userMessage('u1', 'first')];

    const messages = await applyInputs(stored, [messageInput(userMessage('u1', 'edited'))]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'edited' }]);
  });

  it('leaves the stored conversation untouched', async () => {
    const stored = [userMessage('u1', 'first')];

    await applyInputs(stored, [messageInput(userMessage('u2', 'second'))]);

    expect(stored).toHaveLength(1);
  });

  it('resolves a tool call from a chunk-shaped resolution, through the SDK reducer', async () => {
    const stored = [userMessage('u1', 'where am i'), assistantWithCall('a1', 'call-1')];

    const messages = await applyInputs(stored, [
      { kind: 'chunk', payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { latitude: 51.5 } } },
    ]);

    const toolPart = messages[1]?.parts.find((part) => isToolUIPart(part));
    expect(toolPart).toMatchObject({ state: 'output-available', output: { latitude: 51.5 } });
  });

  it('ignores a resolution for a tool call the conversation never held', async () => {
    const stored = [userMessage('u1', 'hello')];

    const messages = await applyInputs(stored, [
      { kind: 'chunk', payload: { type: 'tool-output-available', toolCallId: 'unknown', output: {} } },
    ]);

    expect(messages).toEqual(stored);
  });

  it('flips an approval-requested part to approval-responded, carrying the decision', async () => {
    const stored = [assistantAwaitingApproval('a1', 'call-2')];

    const messages = await applyInputs(stored, [
      { kind: 'approval', payload: { messageId: 'a1', toolCallId: 'call-2', approved: false, reason: 'User denied' } },
    ]);

    const toolPart = messages[0]?.parts.find((part) => isToolUIPart(part));
    expect(toolPart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'appr-1', approved: false, reason: 'User denied' },
    });
  });

  it('leaves a decision for another tool call on the same message alone', async () => {
    const stored = [assistantAwaitingApproval('a1', 'call-2')];

    const messages = await applyInputs(stored, [
      { kind: 'approval', payload: { messageId: 'a1', toolCallId: 'other-call', approved: true } },
    ]);

    const toolPart = messages[0]?.parts.find((part) => isToolUIPart(part));
    expect(toolPart).toMatchObject({ state: 'approval-requested' });
  });

  it('contributes nothing for a regenerate input — the agent acts on it, not the conversation', async () => {
    const stored = [userMessage('u1', 'hello')];

    const messages = await applyInputs(stored, [{ kind: 'regenerate', payload: { messageId: 'a1' } }]);

    expect(messages).toEqual(stored);
  });

  it('applies every input a wire message carried, in order', async () => {
    const stored = [assistantWithCall('a1', 'call-1')];

    const messages = await applyInputs(stored, [
      { kind: 'chunk', payload: { type: 'tool-output-available', toolCallId: 'call-1', output: { latitude: 1 } } },
      messageInput(userMessage('u2', 'and now?')),
    ]);

    expect(messages.map((message) => message.id)).toEqual(['a1', 'u2']);
    expect(messages[0]?.parts.find((part) => isToolUIPart(part))).toMatchObject({ state: 'output-available' });
  });
});
