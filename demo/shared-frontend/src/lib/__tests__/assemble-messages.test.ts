/**
 * Tests for the application half of hydration: turning the groups `readSince`
 * walked into `UIMessage`s through the provider's own reducer.
 *
 * The three cases that used to break when the transport did this work are all
 * here: a client tool resolution, an approval decision, and one assistant
 * message whose output spans two runs.
 */

import { describe, expect, it, vi } from 'vitest';
import type { UIMessage, UIMessageChunk } from 'ai';
import { isToolUIPart } from 'ai';
import type { VercelInput, WalkedEvent, WalkedMessage } from '@ably/ai-transport/vercel';

import { assembleWalkedMessages } from '../assemble-messages';

const out = (event: UIMessageChunk): WalkedEvent => ({ direction: 'output', event });
const inp = (event: VercelInput): WalkedEvent => ({ direction: 'input', event });

const group = (id: string, events: WalkedEvent[]): WalkedMessage => ({ id, events });

const gatedCall: UIMessageChunk[] = [
  { type: 'start', messageId: 'ui-1' },
  { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'getForecast', input: { city: 'London' } },
];

const toolPartOf = (message: UIMessage | undefined) => message?.parts.find((part) => isToolUIPart(part));

describe('assembleWalkedMessages', () => {
  it('assembles an assistant turn through the reducer', async () => {
    const messages = await assembleWalkedMessages([
      group('ui-1', [
        out({ type: 'start', messageId: 'ui-1' }),
        out({ type: 'text-start', id: 't1' }),
        out({ type: 'text-delta', id: 't1', delta: 'hello' }),
        out({ type: 'text-end', id: 't1' }),
        out({ type: 'finish' }),
      ]),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('ui-1');
    expect(messages[0]?.parts).toContainEqual({ type: 'text', text: 'hello', state: 'done' });
  });

  it('concatenates the parts of a client turn the wire fanned out', async () => {
    const messages = await assembleWalkedMessages([
      group('u1', [
        inp({ kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look at ' }] } }),
        inp({ kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'this' }] } }),
      ]),
    ]);

    expect(messages[0]?.parts).toEqual([
      { type: 'text', text: 'look at ' },
      { type: 'text', text: 'this' },
    ]);
  });

  it('resolves a tool call from the resolution grouped with it', async () => {
    const messages = await assembleWalkedMessages([
      group('ui-1', [
        ...gatedCall.map((chunk) => out(chunk)),
        out({ type: 'finish' }),
        inp({
          kind: 'chunk',
          payload: {
            messageId: 'ui-1',
            chunk: { type: 'tool-output-available', toolCallId: 'tc-1', output: { days: 5 } },
          },
        }),
      ]),
    ]);

    expect(toolPartOf(messages[0])).toMatchObject({ state: 'output-available', output: { days: 5 } });
  });

  it('applies an approval decision so the user is not asked again', async () => {
    const messages = await assembleWalkedMessages([
      group('ui-1', [
        ...gatedCall.map((chunk) => out(chunk)),
        out({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'tc-1' }),
        out({ type: 'finish' }),
        inp({ kind: 'approval', payload: { messageId: 'ui-1', toolCallId: 'tc-1', approved: true } }),
      ]),
    ]);

    expect(toolPartOf(messages[0])).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'ap-1', approved: true },
    });
  });

  it('carries a denial reason onto the part', async () => {
    const messages = await assembleWalkedMessages([
      group('ui-1', [
        ...gatedCall.map((chunk) => out(chunk)),
        out({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'tc-1' }),
        out({ type: 'finish' }),
        inp({
          kind: 'approval',
          payload: { messageId: 'ui-1', toolCallId: 'tc-1', approved: false, reason: 'User denied' },
        }),
      ]),
    ]);

    expect(toolPartOf(messages[0])).toMatchObject({
      approval: { approved: false, reason: 'User denied' },
    });
  });

  it('rebuilds one message whose output spans two runs', async () => {
    // The transport joins the two publishes into one group; feeding both to a
    // single reducer call is what resolves the tool call across them.
    const messages = await assembleWalkedMessages([
      group('ui-1', [
        ...gatedCall.map((chunk) => out(chunk)),
        out({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'tc-1' }),
        out({ type: 'finish' }),
        out({ type: 'start', messageId: 'ui-1' }),
        out({ type: 'tool-output-available', toolCallId: 'tc-1', output: { days: 5 } }),
        out({ type: 'finish' }),
      ]),
    ]);

    expect(messages).toHaveLength(1);
    expect(toolPartOf(messages[0])).toMatchObject({ state: 'output-available', output: { days: 5 } });
  });

  it('ignores a decision for a call that is not awaiting one', async () => {
    const messages = await assembleWalkedMessages([
      group('ui-1', [
        ...gatedCall.map((chunk) => out(chunk)),
        out({ type: 'finish' }),
        inp({ kind: 'approval', payload: { messageId: 'ui-1', toolCallId: 'tc-1', approved: true } }),
      ]),
    ]);

    expect(toolPartOf(messages[0])).toMatchObject({ state: 'input-available' });
  });

  it('ignores a regenerate, which names a message rather than carrying one', async () => {
    const messages = await assembleWalkedMessages([
      group('wire-1', [inp({ kind: 'regenerate', payload: { messageId: 'ui-1' } })]),
    ]);

    expect(messages).toEqual([]);
  });

  it('contains a reducer failure to the one message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const messages = await assembleWalkedMessages([
        // A delta with no opener. Whether the reducer skips it or throws is the
        // provider's business; either way the rest of the walk must arrive.
        group('wire-bad', [out({ type: 'text-delta', id: 't1', delta: 'orphan' })]),
        group('ui-2', [
          out({ type: 'start', messageId: 'ui-2' }),
          out({ type: 'text-start', id: 't1' }),
          out({ type: 'text-delta', id: 't1', delta: 'fine' }),
          out({ type: 'text-end', id: 't1' }),
          out({ type: 'finish' }),
        ]),
      ]);

      expect(messages.map((message) => message.id)).toContain('ui-2');
    } finally {
      warn.mockRestore();
    }
  });
});
