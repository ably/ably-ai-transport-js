import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActivityEvent } from '../../lib/wdk-activity';
import { WdkProcessPanel } from '../wdk-process-panel';

// Capture the channel listener so the test can push activity events, and stub
// the ChannelProvider to a passthrough (no Ably client needed). vitest hoists
// vi.mock above the imports, so WdkProcessPanel binds to the mocked ably/react.
let capturedListener: ((message: { data: ActivityEvent }) => void) | null = null;
vi.mock('ably/react', () => ({
  ChannelProvider: ({ children }: { children: ReactNode }) => children,
  useChannel: (_channelName: string, listener: (message: { data: ActivityEvent }) => void) => {
    capturedListener = listener;
    return {};
  },
}));

const event = (over: Partial<ActivityEvent>): ActivityEvent => ({
  kind: 'inference',
  phase: 'running',
  workflowRunId: 'wrun_abcdef1234',
  wdkStepId: 'step_xyz9876543',
  attempt: 1,
  aitRunId: 'run-1234abcd',
  ts: 1,
  ...over,
});

describe('WdkProcessPanel', () => {
  afterEach(() => {
    capturedListener = null;
    vi.unstubAllGlobals();
  });

  it('renders an activity row under its workflow when an event arrives', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })),
    );
    render(<WdkProcessPanel channelName="ai:test" />);

    expect(capturedListener).not.toBeNull();
    act(() => {
      capturedListener?.({ data: event({ kind: 'inference', phase: 'done' }) });
    });

    expect(screen.getByText('inference', { exact: true })).toBeTruthy();
    // The workflow badge shows the id's entropy-bearing tail (see shortId).
    expect(screen.getByText(/wf .+ef1234/)).toBeTruthy();
  });

  it('shows a distinct row per attempt so a WDK retry is visible, marking the dead attempt', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })),
    );
    render(<WdkProcessPanel channelName="ai:test" />);

    act(() => {
      capturedListener?.({ data: event({ attempt: 1, phase: 'running' }) });
      capturedListener?.({ data: event({ attempt: 2, phase: 'done' }) });
    });

    // The attempt-2 badge only appears once a step has been retried.
    expect(screen.getByText('attempt 2')).toBeTruthy();
    // Attempt 1's process died before reporting a terminal phase; once a later
    // attempt exists its row reads as dead, not still-running.
    expect(screen.getByText('died')).toBeTruthy();
  });
});
