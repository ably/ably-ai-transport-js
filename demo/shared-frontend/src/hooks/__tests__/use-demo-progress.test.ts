import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as Ably from 'ably';
import type * as AI from 'ai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';

import { useDemoProgress, type PromptDemoStep } from '../use-demo-progress';

// The stock retry chip is not in the baseline ALL_STEPS; a demo opts in by
// passing it via extraSteps, mirroring the Temporal demo's STOCK_RETRY_STEP.
const STOCK_STEP: PromptDemoStep = {
  id: 'retry-stock',
  type: 'prompt',
  tag: 'Durable retry',
  label: 'stock',
  prompt: "what's the current stock price of AAPL?",
};

const noBranch = (): BranchHandle<AI.UIMessage> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {},
});

const noRun = (): RunInfo | undefined => undefined;

function userTurn(id: string, text: string): CodecMessage<AI.UIMessage> {
  return { codecMessageId: id, message: { id, role: 'user', parts: [{ type: 'text', text, state: 'done' }] } };
}

function stockToolTurn(id: string, state: 'input-available' | 'output-available'): CodecMessage<AI.UIMessage> {
  return {
    codecMessageId: id,
    message: {
      id,
      role: 'assistant',
      parts: [
        // CAST: the tool UI part is a discriminated union keyed on `state`, so a
        // fixture built with a runtime-chosen `state` can't be inferred as one
        // member; assert the part type the hook reads via isToolUIPart/getToolName.
        {
          type: 'tool-getStockPrice',
          toolCallId: `${id}-call`,
          state,
          input: { symbol: 'AAPL' },
          ...(state === 'output-available' ? { output: { symbol: 'AAPL', priceUSD: 100 } } : {}),
        } as AI.ToolUIPart,
      ],
    },
  };
}

function render(messages: CodecMessage<AI.UIMessage>[], extraSteps: readonly PromptDemoStep[] = []) {
  return renderHook(() => useDemoProgress(messages, noBranch, noRun, [] as Ably.InboundMessage[], extraSteps)).result
    .current;
}

describe('useDemoProgress', () => {
  it('omits the stock step unless the demo opts in via extraSteps', () => {
    const steps = render([]);
    expect(steps.some((s) => s.id === 'retry-stock')).toBe(false);
  });

  it('offers an opted-in extra step while its scenario is unfinished', () => {
    const steps = render([], [STOCK_STEP]);
    expect(steps.some((s) => s.id === 'retry-stock')).toBe(true);
  });

  it('marks the stock step done once a turn produces a getStockPrice output', () => {
    const messages = [userTurn('u1', 'stock price of AAPL?'), stockToolTurn('a1', 'output-available')];
    const steps = render(messages, [STOCK_STEP]);
    expect(steps.some((s) => s.id === 'retry-stock')).toBe(false);
  });

  it('keeps the stock step while the tool call has no output yet', () => {
    const messages = [userTurn('u1', 'stock price of AAPL?'), stockToolTurn('a1', 'input-available')];
    const steps = render(messages, [STOCK_STEP]);
    expect(steps.some((s) => s.id === 'retry-stock')).toBe(true);
  });
});
