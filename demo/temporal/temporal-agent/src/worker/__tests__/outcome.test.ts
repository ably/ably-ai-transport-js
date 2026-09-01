/**
 * Tests for the inference activity's two pure decisions: which lifecycle event
 * an outcome publishes, and which of the model's tool calls this worker runs
 * itself.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentRunTransport } from '@ably/ai-transport';
import type { VercelOutput } from '@ably/ai-transport/vercel';

import { filterServerToolCalls, publishRunTerminal } from '../outcome';

type EndParams = Parameters<AgentRunTransport<VercelOutput>['end']>[0];

const fakeRun = () => ({ end: vi.fn<(params: EndParams) => Promise<void>>(async () => undefined) });

describe('publishRunTerminal', () => {
  it('ends a turn waiting on the client complete, rather than suspending it', async () => {
    const run = fakeRun();
    await publishRunTerminal(run, { kind: 'awaiting-client' });
    // The useChat adapter publishes each resolution with no run id, so the
    // continuation opens a fresh run and a suspended one would hang for ever.
    expect(run.end).toHaveBeenCalledWith({ reason: 'complete' });
  });

  it('publishes nothing for the non-terminal server-tools outcome', async () => {
    const run = fakeRun();
    await publishRunTerminal(run, { kind: 'server-tools', serverToolCalls: [] });
    expect(run.end).not.toHaveBeenCalled();
  });

  it('carries the failure message onto the run-end error', async () => {
    const run = fakeRun();
    await publishRunTerminal(run, { kind: 'error', errorMessage: 'model refused' });
    expect(run.end).toHaveBeenCalledTimes(1);
    const params = run.end.mock.calls[0][0];
    expect(params?.reason).toBe('error');
    expect(params?.reason === 'error' ? params.error?.message : undefined).toBe('model refused');
  });

  it('passes complete and cancelled through as the run-end reason', async () => {
    const complete = fakeRun();
    await publishRunTerminal(complete, { kind: 'complete' });
    expect(complete.end).toHaveBeenCalledWith({ reason: 'complete' });

    const cancelled = fakeRun();
    await publishRunTerminal(cancelled, { kind: 'cancelled' });
    expect(cancelled.end).toHaveBeenCalledWith({ reason: 'cancelled' });
  });
});

describe('filterServerToolCalls', () => {
  it('keeps a tool the worker can execute', () => {
    const calls = [{ toolCallId: 'c1', toolName: 'getWeather', input: { location: 'Tokyo' } }];
    expect(filterServerToolCalls(calls)).toEqual(calls);
  });

  it('drops a client-executed tool, which has no execute in the registry', () => {
    expect(filterServerToolCalls([{ toolCallId: 'c1', toolName: 'getLocation', input: {} }])).toEqual([]);
  });

  it('drops a name that is not in the registry at all', () => {
    expect(filterServerToolCalls([{ toolCallId: 'c1', toolName: 'notATool', input: {} }])).toEqual([]);
  });

  it('splits a mixed batch, keeping wire order', () => {
    const calls = [
      { toolCallId: 'c1', toolName: 'getLocation', input: {} },
      { toolCallId: 'c2', toolName: 'getWeather', input: { location: 'Paris' } },
      { toolCallId: 'c3', toolName: 'getWeatherForecast', input: { location: 'London' } },
    ];
    expect(filterServerToolCalls(calls).map((call) => call.toolCallId)).toEqual(['c2', 'c3']);
  });
});
