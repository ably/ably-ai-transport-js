import { describe, expect, it } from 'vitest';

import type { WdkTransportEvent } from '../../lib/merge-messages';
import { collectHistory, latestRunLifecycle } from '../history';

function lifecycle(runId: string, type: 'start' | 'suspend' | 'resume', invocationId = ''): WdkTransportEvent {
  return { kind: 'run-lifecycle', event: { type, runId, clientId: '', invocationId, serial: undefined } };
}

describe('collectHistory', () => {
  it('pages backwards to exhaustion, prepending each older batch', async () => {
    const older = [lifecycle('r1', 'start')];
    const newer = [lifecycle('r1', 'resume')];
    const batches = [
      { events: newer, exhausted: false },
      { events: older, exhausted: true },
    ];
    let call = 0;
    const events = await collectHistory({
      history: async () => {
        const batch = batches[call];
        call += 1;
        return batch;
      },
    });

    expect(events).toEqual([...older, ...newer]);
  });
});

describe('latestRunLifecycle', () => {
  it('returns the newest lifecycle event for the run, skipping other runs', () => {
    const events = [
      lifecycle('r1', 'start', 'inv-1'),
      lifecycle('r2', 'start', 'inv-2'),
      lifecycle('r1', 'resume', 'inv-3'),
    ];
    const latest = latestRunLifecycle(events, 'r1');
    expect(latest?.type).toBe('resume');
    expect(latest?.invocationId).toBe('inv-3');
  });

  it('returns undefined when the run has no lifecycle event in the batch', () => {
    expect(latestRunLifecycle([lifecycle('r2', 'start')], 'r1')).toBeUndefined();
  });
});
