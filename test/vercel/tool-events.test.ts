import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { MessageNode } from '../../src/core/transport/types.js';
import { applyToolEventsToHistory } from '../../src/vercel/tool-events.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeAssistantWithToolInput = (
  uiMsgId: string,
  toolCallId: string,
  input: Record<string, unknown>,
): AI.UIMessage => ({
  id: uiMsgId,
  role: 'assistant',
  parts: [
    { type: 'step-start' },
    { type: 'text', text: 'running the tool...' },
    {
      type: 'dynamic-tool',
      toolCallId,
      toolName: 'getLocation',
      state: 'input-available',
      input,
    },
  ],
});

const makeNode = (msgId: string, message: AI.UIMessage): MessageNode<AI.UIMessage> => ({
  kind: 'message',
  msgId,
  parentId: undefined,
  forkOf: undefined,
  message,
  headers: {},
  serial: '',
});

// ---------------------------------------------------------------------------
// applyToolEventsToHistory
// ---------------------------------------------------------------------------

describe('applyToolEventsToHistory', () => {
  it('returns the original array when there are no events', () => {
    const treeMsg = makeAssistantWithToolInput('u1', 't1', {});
    const nodes = [makeNode('m1', treeMsg)];
    expect(applyToolEventsToHistory([], nodes)).toBe(nodes);
  });

  it('folds a tool-output-available event into the matching node', () => {
    const input = { highAccuracy: false };
    const output = { latitude: 51.5, longitude: -0.1 };
    const treeMsg = makeAssistantWithToolInput('u1', 't1', input);
    const nodes = [makeNode('m1', treeMsg)];

    const updated = applyToolEventsToHistory(
      [
        {
          kind: 'event',
          msgId: 'm1',
          events: [
            {
              type: 'tool-output-available',
              toolCallId: 't1',
              output,
              dynamic: true,
              providerExecuted: false,
              preliminary: false,
            },
          ],
        },
      ],
      nodes,
    );

    expect(updated).toHaveLength(1);
    const toolPart = updated[0]?.message.parts.find((p) => p.type === 'dynamic-tool');
    expect(toolPart).toMatchObject({
      type: 'dynamic-tool',
      toolCallId: 't1',
      state: 'output-available',
      output,
    });
  });

  it('leaves non-targeted nodes untouched', () => {
    const otherMsg: AI.UIMessage = {
      id: 'other',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const treeMsg = makeAssistantWithToolInput('u1', 't1', {});
    const nodes = [makeNode('m0', otherMsg), makeNode('m1', treeMsg)];

    const updated = applyToolEventsToHistory(
      [
        {
          kind: 'event',
          msgId: 'm1',
          events: [
            {
              type: 'tool-output-available',
              toolCallId: 't1',
              output: { value: 42 },
              dynamic: true,
              providerExecuted: false,
              preliminary: false,
            },
          ],
        },
      ],
      nodes,
    );

    expect(updated[0]).toBe(nodes[0]);
  });
});
