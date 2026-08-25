/**
 * Tests for the demo's `getStockPrice` tool. It is deliberately flaky: it
 * generates a whole-dollar price and throws on an odd price, succeeding only
 * on an even one — the demo relies on that to show Temporal's activity retry.
 * These tests pin `Math.random` so the odd/even branch is deterministic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionOptions } from 'ai';

import { tools } from '../tools';

const callOptions: ToolExecutionOptions<unknown> = { toolCallId: 'call-1', messages: [], context: undefined };

function runGetStockPrice(symbol: string) {
  const execute = tools.getStockPrice.execute;
  if (!execute) throw new Error('getStockPrice must have an execute function');
  return execute({ symbol }, callOptions);
}

describe('getStockPrice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the price when it lands even', async () => {
    // Math.round(50 + 0 * 500) === 50, which is even.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await expect(runGetStockPrice('AAPL')).resolves.toEqual({ symbol: 'AAPL', priceUSD: 50 });
  });

  it('throws when the price lands odd', async () => {
    // Math.round(50 + 0.002 * 500) === 51, which is odd.
    vi.spyOn(Math, 'random').mockReturnValue(0.002);
    await expect(runGetStockPrice('AAPL')).rejects.toThrow(/odd price \(51\)/);
  });
});
