import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { disableApprovalsForApproved } from '../../src/vercel/tool-approvals.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const assistantWithToolPart = (state: AI.DynamicToolUIPart['state'], toolName: string): AI.UIMessage => ({
  id: 'asst-1',
  role: 'assistant',
  parts: [
    // CAST: AI SDK's DynamicToolUIPart discriminated union per-state shape
    // constraints — building a minimal part for the test purely from state +
    // toolCallId/toolName + (when required) approval.
    state === 'approval-responded'
      ? ({
          type: 'dynamic-tool',
          toolName,
          toolCallId: 'tc-1',
          state: 'approval-responded',
          input: {},
          approval: { id: 'a-1', approved: true },
        } as AI.UIMessagePart<AI.UIDataTypes, AI.UITools>)
      : state === 'output-denied'
        ? ({
            type: 'dynamic-tool',
            toolName,
            toolCallId: 'tc-1',
            state: 'output-denied',
            input: {},
            approval: { id: 'a-1', approved: false },
          } as AI.UIMessagePart<AI.UIDataTypes, AI.UITools>)
        : ({
            type: 'dynamic-tool',
            toolName,
            toolCallId: 'tc-1',
            state: 'approval-requested',
            input: {},
            approval: { id: 'a-1' },
          } as AI.UIMessagePart<AI.UIDataTypes, AI.UITools>),
  ],
});

interface FakeTool {
  needsApproval?: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('disableApprovalsForApproved', () => {
  it('returns the input tools dict unchanged when no approval-responded parts are present', () => {
    const tools: Record<string, FakeTool> = {
      getWeather: { needsApproval: false, description: 'a' },
      getForecast: { needsApproval: true, description: 'b' },
    };
    const messages: AI.UIMessage[] = [
      { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      assistantWithToolPart('approval-requested', 'getForecast'),
    ];

    const result = disableApprovalsForApproved(messages, tools);
    // Same reference — early return when no approvals found.
    expect(result).toBe(tools);
  });

  it('flips needsApproval to false on tools matching approval-responded parts', () => {
    const tools: Record<string, FakeTool> = {
      getWeather: { needsApproval: false, description: 'a' },
      getForecast: { needsApproval: true, description: 'b' },
    };
    const messages: AI.UIMessage[] = [assistantWithToolPart('approval-responded', 'getForecast')];

    const result = disableApprovalsForApproved(messages, tools);
    expect(result.getForecast?.needsApproval).toBe(false);
    // Unrelated tools untouched.
    expect(result.getWeather?.needsApproval).toBe(false);
    // Other fields preserved.
    expect(result.getForecast?.description).toBe('b');
  });

  it('does not flip needsApproval on tools matching output-denied parts', () => {
    const tools: Record<string, FakeTool> = {
      getForecast: { needsApproval: true, description: 'b' },
    };
    const messages: AI.UIMessage[] = [assistantWithToolPart('output-denied', 'getForecast')];

    const result = disableApprovalsForApproved(messages, tools);
    expect(result).toBe(tools);
    expect(result.getForecast?.needsApproval).toBe(true);
  });

  it('handles a mix of approved and denied tools across multiple messages', () => {
    const tools: Record<string, FakeTool> = {
      getForecast: { needsApproval: true, description: 'b' },
      sendEmail: { needsApproval: true, description: 'c' },
    };
    const m1 = assistantWithToolPart('approval-responded', 'getForecast');
    const m2: AI.UIMessage = {
      id: 'asst-2',
      role: 'assistant',
      parts: [
        // CAST: same as helper above.
        {
          type: 'dynamic-tool',
          toolName: 'sendEmail',
          toolCallId: 'tc-2',
          state: 'output-denied',
          input: {},
          approval: { id: 'a-2', approved: false },
        } as AI.UIMessagePart<AI.UIDataTypes, AI.UITools>,
      ],
    };

    const result = disableApprovalsForApproved([m1, m2], tools);
    expect(result.getForecast?.needsApproval).toBe(false);
    expect(result.sendEmail?.needsApproval).toBe(true);
  });
});
