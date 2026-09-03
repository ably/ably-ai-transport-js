import { describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { FakeRoot, asRoot } from './fake-root';
import { makeChecklistTool } from '../api/chat/checklist-tool';

type ExecuteArgs = { plan?: string[]; start?: number[]; complete?: number[] };

/** Invoke the tool's execute with a fixed clock and typed args. */
async function run(fake: FakeRoot, args: ExecuteArgs, now = 1000): Promise<unknown> {
  const tool = makeChecklistTool(asRoot(fake), () => now).updateChecklist as Tool & {
    execute: (input: ExecuteArgs, options: unknown) => Promise<unknown>;
  };
  return tool.execute(args, {});
}

describe('makeChecklistTool', () => {
  it('writes a plan as numbered pending steps', async () => {
    const fake = new FakeRoot();
    const result = await run(fake, { plan: ['First', 'Second'] }, 5);

    expect(fake.state).toEqual({
      '1': { text: 'First', status: 'pending', updatedAt: 5 },
      '2': { text: 'Second', status: 'pending', updatedAt: 5 },
    });
    expect(result).toEqual({ planned: 2, started: [], completed: [] });
  });

  it('flips a single step to active without touching the others', async () => {
    const fake = new FakeRoot({
      '1': { text: 'First', status: 'pending', updatedAt: 1 },
      '2': { text: 'Second', status: 'pending', updatedAt: 1 },
    });
    const result = await run(fake, { start: [1] }, 50);

    expect(fake.state['1']).toEqual({ text: 'First', status: 'active', updatedAt: 50 });
    // The untouched step keeps its original value, including its timestamp.
    expect(fake.state['2']).toEqual({ text: 'Second', status: 'pending', updatedAt: 1 });
    expect(result).toEqual({ planned: 0, started: [1], completed: [] });
  });

  it('marks a step done, preserving its text', async () => {
    const fake = new FakeRoot({ '1': { text: 'First', status: 'active', updatedAt: 1 } });
    await run(fake, { complete: [1] }, 9);

    expect(fake.state['1']).toEqual({ text: 'First', status: 'done', updatedAt: 9 });
  });

  it('re-planning drops steps beyond the new, shorter list', async () => {
    const fake = new FakeRoot({
      '1': { text: 'A', status: 'done', updatedAt: 1 },
      '2': { text: 'B', status: 'done', updatedAt: 1 },
      '3': { text: 'C', status: 'done', updatedAt: 1 },
    });
    await run(fake, { plan: ['Only one'] }, 7);

    expect(fake.state).toEqual({ '1': { text: 'Only one', status: 'pending', updatedAt: 7 } });
  });

  it('ignores start/complete for steps that do not exist', async () => {
    const fake = new FakeRoot({ '1': { text: 'First', status: 'pending', updatedAt: 1 } });
    const result = await run(fake, { start: [2], complete: [3] }, 4);

    expect(fake.state).toEqual({ '1': { text: 'First', status: 'pending', updatedAt: 1 } });
    // Only steps that actually existed are reported as applied.
    expect(result).toEqual({ planned: 0, started: [], completed: [] });
  });

  it('applies plan and a status flip together in one batch (one notify)', async () => {
    const fake = new FakeRoot();
    const notify = vi.fn();
    fake.subscribe(notify);

    const result = await run(fake, { plan: ['First', 'Second'], start: [1] }, 3);

    expect(fake.state).toEqual({
      '1': { text: 'First', status: 'active', updatedAt: 3 },
      '2': { text: 'Second', status: 'pending', updatedAt: 3 },
    });
    expect(result).toEqual({ planned: 2, started: [1], completed: [] });
    // One batch -> one channel message -> observers notified once.
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
