import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CodecMessage, RunInfo } from '@ably/ai-transport';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { OpenAIMessage, OpenAISessionInput } from '@ably/ai-transport/openai';

import { useClientTools } from '../use-client-tools';

type Handle = ViewHandle<OpenAISessionInput, OpenAIMessage>;

// An assistant turn holding an unresolved getLocation client-tool call (no
// function_call_output yet), addressed to codec-message-id `cm-0`.
const locationCall = (): OpenAIMessage => ({
  role: 'assistant',
  items: [{ type: 'function_call', call_id: 'c1', name: 'getLocation', arguments: '{}', status: 'completed' }],
});

const makeView = (status: 'active' | 'suspended' | 'complete' | 'cancelled'): Handle => {
  const messages: CodecMessage<OpenAIMessage>[] = [{ codecMessageId: 'cm-0', message: locationCall() }];
  const runOf = vi.fn((id: string): RunInfo | undefined =>
    id === 'cm-0' ? { runId: 'r1', clientId: 'c', status, invocationId: 'i1', steps: [] } : undefined,
  );
  // CAST: partial ViewHandle; the hook reads only messages and runOf.
  return { messages, runOf } as unknown as Handle;
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
    renderHook(() => useClientTools(makeView('active'), 'c', resolve));
    // This lets any (unwanted) async execution run.
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('hands the tool result to the resolution gate once the run is suspended', async () => {
    const resolve = vi.fn(async () => {});
    renderHook(() => useClientTools(makeView('suspended'), 'c', resolve));
    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(1);
    });
    expect(resolve).toHaveBeenCalledWith({
      codecMessageId: 'cm-0',
      callId: 'c1',
      input: expect.objectContaining({ kind: 'tool-result' }),
    });
  });

  it('does not execute a call from a run another client initiated', async () => {
    const resolve = vi.fn(async () => {});
    renderHook(() => useClientTools(makeView('suspended'), 'other-client', resolve));
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
  });
});
