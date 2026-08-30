import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ClientRun, CodecMessage, RunInfo } from '@ably/ai-transport';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { OpenAIMessage, OpenAISessionInput } from '@ably/ai-transport/openai';
import { ResponsesSessionCodec } from '@ably/ai-transport/openai';

import { useToolResolution } from '../use-tool-resolution';

type Handle = ViewHandle<OpenAISessionInput, OpenAIMessage>;

/** A gated function_call item awaiting a decision. */
const gatedCall = (callId: string) => ({
  type: 'function_call' as const,
  call_id: callId,
  name: 'getWeatherForecast',
  arguments: '{}',
  status: 'completed' as const,
});

/**
 * A view holding one assistant message on run `r1` whose gated calls are all
 * still pending. Resolutions are wire-only, so the view deliberately never
 * reflects an answer — the hook must reach readiness from its own record of what
 * it answered.
 */
const makeView = (callIds: string[]): { view: Handle; send: ReturnType<typeof vi.fn> } => {
  const send = vi.fn(async () => ({ runId: 'r1' }) as unknown as ClientRun<OpenAISessionInput, OpenAIMessage>);
  const message: OpenAIMessage = {
    role: 'assistant',
    items: callIds.map(gatedCall),
    toolCallStates: Object.fromEntries(callIds.map((id) => [id, { approval: 'pending' as const }])),
  };
  const messages: CodecMessage<OpenAIMessage>[] = [{ codecMessageId: 'cm-0', message }];
  const runOf = vi.fn((id: string): RunInfo | undefined =>
    id === 'cm-0' ? { runId: 'r1', clientId: 'c', status: 'suspended', invocationId: 'i1', steps: [] } : undefined,
  );
  // CAST: partial ViewHandle; the hook reads only messages, runOf, and send.
  const view = { messages, runOf, send } as unknown as Handle;
  return { view, send };
};

const approval = (callId: string): OpenAISessionInput =>
  ResponsesSessionCodec.createToolApprovalResponse('cm-0', { call_id: callId, approved: true });

const setup = (callIds: string[]) => {
  const { view, send } = makeView(callIds);
  const onWake = vi.fn();
  const { result } = renderHook(() => useToolResolution({ view, onWake }));
  return { resolve: result.current, send, onWake };
};

describe('useToolResolution', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('wakes the agent when the run has a single call and it is answered', async () => {
    const { resolve, send, onWake } = setup(['c1']);
    await resolve({ codecMessageId: 'cm-0', callId: 'c1', input: approval('c1') });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('publishes but does not wake while another call is still unanswered', async () => {
    const { resolve, send, onWake } = setup(['c1', 'c2']);
    await resolve({ codecMessageId: 'cm-0', callId: 'c1', input: approval('c1') });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('wakes once the second of two calls is answered', async () => {
    const { resolve, send, onWake } = setup(['c1', 'c2']);
    await resolve({ codecMessageId: 'cm-0', callId: 'c1', input: approval('c1') });
    await resolve({ codecMessageId: 'cm-0', callId: 'c2', input: approval('c2') });
    expect(send).toHaveBeenCalledTimes(2);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('wakes exactly once when both answers race', async () => {
    const { resolve, onWake } = setup(['c1', 'c2']);
    await Promise.all([
      resolve({ codecMessageId: 'cm-0', callId: 'c1', input: approval('c1') }),
      resolve({ codecMessageId: 'cm-0', callId: 'c2', input: approval('c2') }),
    ]);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('publishes the resolution on the run that owns the answered message', async () => {
    const { resolve, send } = setup(['c1']);
    const input = approval('c1');
    await resolve({ codecMessageId: 'cm-0', callId: 'c1', input });
    expect(send).toHaveBeenCalledWith([input], { runId: 'r1' });
  });

  it('does nothing when the message has no owning run', async () => {
    const { resolve, send, onWake } = setup(['c1']);
    await resolve({ codecMessageId: 'unknown', callId: 'c1', input: approval('c1') });
    expect(send).not.toHaveBeenCalled();
    expect(onWake).not.toHaveBeenCalled();
  });
});
