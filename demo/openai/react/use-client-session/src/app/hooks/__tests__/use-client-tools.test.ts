import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CodecMessage, RunInfo } from '@ably/ai-transport';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { OpenAIInput, OpenAIMessage } from '@ably/ai-transport/openai';

import { useClientTools } from '../use-client-tools';

vi.mock('../../helpers', () => ({
  wakeAgent: vi.fn(async () => ({ runId: 'r1', invocationId: 'i1' })),
}));

type Handle = ViewHandle<OpenAIInput, OpenAIMessage>;

// An assistant turn holding an unresolved getLocation client-tool call (no
// function_call_output yet), addressed to codec-message-id `cm-0`.
const locationCall = (): OpenAIMessage => ({
  role: 'assistant',
  items: [{ type: 'function_call', call_id: 'c1', name: 'getLocation', arguments: '{}', status: 'completed' }],
});

const makeView = (
  status: 'active' | 'suspended' | 'complete' | 'cancelled',
): { view: Handle; send: ReturnType<typeof vi.fn> } => {
  const send = vi.fn(async () => ({ toInvocation: () => ({ toJSON: () => ({}) }) }));
  const messages: CodecMessage<OpenAIMessage>[] = [{ codecMessageId: 'cm-0', message: locationCall() }];
  const runOf = vi.fn((id: string): RunInfo | undefined =>
    id === 'cm-0' ? { runId: 'r1', clientId: 'c', status, invocationId: 'i1', steps: [] } : undefined,
  );
  // CAST: partial ViewHandle; the hook reads only messages, runOf, and send.
  const view = { messages, runOf, send } as unknown as Handle;
  return { view, send };
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

  it('does not execute or poke while the run is still active', async () => {
    const { view, send } = makeView('active');
    renderHook(() => useClientTools(view, '/api/chat'));
    // This lets any (unwanted) async execution run.
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('executes and pokes once the run is suspended', async () => {
    const { view, send } = makeView('suspended');
    renderHook(() => useClientTools(view, '/api/chat'));
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'tool-result' })],
      expect.objectContaining({ runId: 'r1' }),
    );
  });
});
