import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { RunStatus } from '@ably/ai-transport';

import type { RunSummary, ThreadMessage } from '../../lib/merge-thread';
import { useClientTools } from '../use-client-tools';

// The thread: the user trigger (carrying the initiator's clientId) and an
// assistant turn holding an unresolved getLocation client-tool call (no
// function_call_output yet), addressed to codec-message-id `cm-1` on run `r1`.
const makeThread = (
  runStatus: RunStatus,
  initiatorClientId = 'c',
): { messages: ThreadMessage[]; runs: ReadonlyMap<string, RunSummary> } => {
  const messages: ThreadMessage[] = [
    {
      codecMessageId: 'cm-0',
      role: 'user',
      clientId: initiatorClientId,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'where am I?' }] }],
    },
    {
      codecMessageId: 'cm-1',
      role: 'assistant',
      runId: 'r1',
      items: [{ type: 'function_call', call_id: 'c1', name: 'getLocation', arguments: '{}', status: 'completed' }],
    },
  ];
  const runs = new Map<string, RunSummary>([['r1', { status: runStatus, inputCodecMessageId: 'cm-0' }]]);
  return { messages, runs };
};

describe('useClientTools', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) => {
          // CAST: test stub; only the coords the executor reads are supplied.
          success({ coords: { latitude: 51.5, longitude: -0.1 } } as GeolocationPosition);
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not execute while the run is still active', async () => {
    const resolve = vi.fn(async () => {});
    const { messages, runs } = makeThread('active');
    renderHook(() => useClientTools({ messages, runs, clientId: 'c', resolve }));
    // This lets any (unwanted) async execution run.
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('hands the tool result to the resolution gate once the run is suspended', async () => {
    const resolve = vi.fn(async () => {});
    const { messages, runs } = makeThread('suspended');
    renderHook(() => useClientTools({ messages, runs, clientId: 'c', resolve }));
    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(1);
    });
    expect(resolve).toHaveBeenCalledWith({
      codecMessageId: 'cm-1',
      runId: 'r1',
      callId: 'c1',
      inputs: [
        {
          kind: 'item',
          payload: {
            type: 'function_call_output',
            call_id: 'c1',
            output: JSON.stringify({ latitude: 51.5, longitude: -0.1 }),
          },
        },
      ],
    });
  });

  it('does not execute a call from a run another client initiated', async () => {
    const resolve = vi.fn(async () => {});
    const { messages, runs } = makeThread('suspended', 'other-client');
    renderHook(() => useClientTools({ messages, runs, clientId: 'c', resolve }));
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('un-marks a call whose resolution publish fails, so a later render retries it', async () => {
    const failure = new Error('publish failed');
    const resolve = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const onError = vi.fn();
    const { messages, runs } = makeThread('suspended');

    // A fresh array per render, as the merge produces on every event.
    const { rerender } = renderHook(() =>
      useClientTools({ messages: [...messages], runs, clientId: 'c', resolve, onError }),
    );
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });

    // The resolution never reached the wire, so the run is still suspended and
    // the call has to remain retryable.
    rerender();
    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(2);
    });
  });

  it('does not re-execute a call whose output is already in the thread', async () => {
    const resolve = vi.fn(async () => {});
    const { messages, runs } = makeThread('suspended');
    messages[1].items.push({ type: 'function_call_output', call_id: 'c1', output: '{"latitude":1}' });
    renderHook(() => useClientTools({ messages, runs, clientId: 'c', resolve }));
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });
});
