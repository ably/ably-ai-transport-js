import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ClientTransport, PublishInputResult } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIInput } from '../../lib/openai-thread';

import type { ThreadMessage } from '../../lib/fold-thread';
import { useToolResolution } from '../use-tool-resolution';

/** A gated function_call item awaiting a decision. */
const gatedCall = (callId: string) => ({
  type: 'function_call' as const,
  call_id: callId,
  name: 'getWeatherForecast',
  arguments: '{}',
  status: 'completed' as const,
});

/**
 * A thread holding one assistant message on run `r1` whose gated calls are all
 * still pending. Resolutions are wire-only, so the thread deliberately never
 * reflects an answer — the hook must reach readiness from its own record of what
 * it answered.
 */
const makeThread = (callIds: string[]) => {
  const publishInput = vi.fn(
    async (): Promise<PublishInputResult> => ({
      codecMessageId: 'cm-0',
      eventId: 'ev-1',
      runId: Promise.resolve('r1'),
    }),
  );
  const messages: ThreadMessage[] = [
    {
      codecMessageId: 'cm-0',
      runId: 'r1',
      role: 'assistant',
      items: callIds.map(gatedCall),
      toolCallStates: Object.fromEntries(callIds.map((id) => [id, { approval: 'pending' as const }])),
    },
  ];
  // CAST: partial ClientTransport; the hook only calls publishInput.
  const transport = { publishInput } as unknown as ClientTransport<OpenAIInput, OpenAIOutput>;
  return { transport, messages, publishInput };
};

const approval = (callId: string): OpenAIInput => ({
  kind: 'approval',
  payload: { call_id: callId, approved: true },
});

const setup = (callIds: string[]) => {
  const { transport, messages, publishInput } = makeThread(callIds);
  const onWake = vi.fn();
  const { result } = renderHook(() => useToolResolution({ transport, messages, onWake }));
  return { resolve: result.current, publishInput, onWake };
};

describe('useToolResolution', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('wakes the agent when the run has a single call and it is answered', async () => {
    const { resolve, publishInput, onWake } = setup(['c1']);
    await resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c1', inputs: [approval('c1')] });
    expect(publishInput).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith({ eventId: 'ev-1' });
  });

  it('publishes but does not wake while another call is still unanswered', async () => {
    const { resolve, publishInput, onWake } = setup(['c1', 'c2']);
    await resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c1', inputs: [approval('c1')] });
    expect(publishInput).toHaveBeenCalledTimes(1);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('wakes once the second of two calls is answered', async () => {
    const { resolve, publishInput, onWake } = setup(['c1', 'c2']);
    await resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c1', inputs: [approval('c1')] });
    await resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c2', inputs: [approval('c2')] });
    expect(publishInput).toHaveBeenCalledTimes(2);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('wakes exactly once when both answers race', async () => {
    const { resolve, onWake } = setup(['c1', 'c2']);
    await Promise.all([
      resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c1', inputs: [approval('c1')] }),
      resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c2', inputs: [approval('c2')] }),
    ]);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('publishes every input of a resolution against the answered message and its run', async () => {
    const { resolve, publishInput } = setup(['c1']);
    const decision = approval('c1');
    const rejection: OpenAIInput = {
      kind: 'item',
      payload: { type: 'function_call_output', call_id: 'c1', output: '{"error":"denied"}' },
    };
    await resolve({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c1', inputs: [decision, rejection] });
    expect(publishInput).toHaveBeenNthCalledWith(1, decision, { codecMessageId: 'cm-0', runId: 'r1' });
    expect(publishInput).toHaveBeenNthCalledWith(2, rejection, { codecMessageId: 'cm-0', runId: 'r1' });
  });

  it('does nothing without a transport', async () => {
    const onWake = vi.fn();
    const { result } = renderHook(() => useToolResolution({ transport: undefined, messages: [], onWake }));
    await result.current({ codecMessageId: 'cm-0', runId: 'r1', callId: 'c1', inputs: [approval('c1')] });
    expect(onWake).not.toHaveBeenCalled();
  });
});
