import { describe, expect, it } from 'vitest';

import { createLifecycleTracker } from '../../../src/core/codec/lifecycle-tracker.js';

// Simple string events for testing
const phases = [
  { key: 'start', build: (ctx: Record<string, string | undefined>) => [`start:${ctx.id ?? ''}`] },
  { key: 'step', build: () => ['step'] },
];

describe('LifecycleTracker', () => {
  it('ensurePhases returns all phases on first call', () => {
    const tracker = createLifecycleTracker(phases);
    const events = tracker.ensurePhases('turn-1', { id: 'msg-1' });
    expect(events).toEqual(['start:msg-1', 'step']);
  });

  it('ensurePhases returns empty on repeat call', () => {
    const tracker = createLifecycleTracker(phases);
    tracker.ensurePhases('turn-1', { id: 'msg-1' });
    const events = tracker.ensurePhases('turn-1', { id: 'msg-1' });
    expect(events).toEqual([]);
  });

  it('markEmitted prevents synthesis of that phase', () => {
    const tracker = createLifecycleTracker(phases);
    tracker.markEmitted('turn-1', 'start');
    const events = tracker.ensurePhases('turn-1', { id: 'msg-1' });
    expect(events).toEqual(['step']);
  });

  it('resetPhase allows re-synthesis', () => {
    const tracker = createLifecycleTracker(phases);
    tracker.ensurePhases('turn-1', { id: 'msg-1' });
    tracker.resetPhase('turn-1', 'step');
    const events = tracker.ensurePhases('turn-1', { id: 'msg-1' });
    expect(events).toEqual(['step']);
  });

  it('clearScope resets everything', () => {
    const tracker = createLifecycleTracker(phases);
    tracker.ensurePhases('turn-1', { id: 'msg-1' });
    tracker.clearScope('turn-1');
    const events = tracker.ensurePhases('turn-1', { id: 'msg-2' });
    expect(events).toEqual(['start:msg-2', 'step']);
  });

  it('multiple scopes are independent', () => {
    const tracker = createLifecycleTracker(phases);
    tracker.ensurePhases('turn-1', { id: 'msg-1' });
    const events = tracker.ensurePhases('turn-2', { id: 'msg-2' });
    expect(events).toEqual(['start:msg-2', 'step']);
  });

  it('build function receives context', () => {
    const tracker = createLifecycleTracker([
      { key: 'a', build: (ctx: Record<string, string | undefined>) => [`${ctx.x ?? ''}-${ctx.y ?? ''}`] },
    ]);
    const events = tracker.ensurePhases('s1', { x: 'hello', y: 'world' });
    expect(events).toEqual(['hello-world']);
  });

  it('phase order is preserved in output', () => {
    const tracker = createLifecycleTracker([
      { key: 'first', build: () => ['1'] },
      { key: 'second', build: () => ['2'] },
      { key: 'third', build: () => ['3'] },
    ]);
    const events = tracker.ensurePhases('s1', {});
    expect(events).toEqual(['1', '2', '3']);
  });
});
