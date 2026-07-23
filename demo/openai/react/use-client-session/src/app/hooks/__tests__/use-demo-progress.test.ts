import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as Ably from 'ably';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { EVENT_CANCEL } from '@ably/ai-transport';
import type { OpenAIMessage } from '@ably/ai-transport/openai';

import { useDemoProgress, type DemoStepId } from '../use-demo-progress';

// --- fixtures ----------------------------------------------------------------

const textTurn = (role: 'user' | 'assistant', text: string): OpenAIMessage => ({
  role,
  items: [
    role === 'user'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
      : {
          id: 'm',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
  ],
});

// An assistant turn that ran getWeather: the call paired with its output.
const weatherTurn = (): OpenAIMessage => ({
  role: 'assistant',
  items: [
    {
      type: 'function_call',
      call_id: 'c1',
      name: 'getWeather',
      arguments: '{"location":"Tokyo"}',
      status: 'completed',
    },
    { type: 'function_call_output', call_id: 'c1', output: '{"temperature":60}' },
    {
      id: 'm',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Sunny.', annotations: [] }],
    },
  ],
});

// The same getWeather run split across separate messages, as the transport
// publishes it: the call in one message and its output in a sibling message.
const weatherCallTurn = (): OpenAIMessage => ({
  role: 'assistant',
  items: [
    {
      type: 'function_call',
      call_id: 'c1',
      name: 'getWeather',
      arguments: '{"location":"Tokyo"}',
      status: 'completed',
    },
  ],
});
const weatherOutputTurn = (): OpenAIMessage => ({
  role: 'assistant',
  items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":60}' }],
});

const paired = (turns: OpenAIMessage[]): CodecMessage<OpenAIMessage>[] =>
  turns.map((message, i) => ({ codecMessageId: `cm-${i}`, message }));

const noBranch: (id: string) => BranchHandle<OpenAIMessage> = () => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {},
});

const run =
  (byId: Record<string, string>) =>
  (codecMessageId: string): RunInfo | undefined =>
    byId[codecMessageId]
      ? { runId: 'r', clientId: byId[codecMessageId], status: 'complete', invocationId: 'i', steps: [] }
      : undefined;

const idsOf = (steps: { id: DemoStepId }[]): DemoStepId[] => steps.map((s) => s.id);

// --- tests -------------------------------------------------------------------

describe('useDemoProgress', () => {
  it('lists all five steps when nothing has been demonstrated', () => {
    const { result } = renderHook(() => useDemoProgress([], noBranch, () => undefined, []));
    expect(idsOf(result.current)).toEqual(['server-weather', 'multi-tab', 'edit', 'regenerate', 'cancel']);
  });

  it('drops server-weather once a getWeather tool turn is present', () => {
    const messages = paired([textTurn('user', "what's the weather in Tokyo?"), weatherTurn()]);
    const { result } = renderHook(() => useDemoProgress(messages, noBranch, () => undefined, []));
    expect(idsOf(result.current)).not.toContain('server-weather');
  });

  it('drops server-weather when the call and its output are in separate messages', () => {
    const messages = paired([textTurn('user', "what's the weather in Tokyo?"), weatherCallTurn(), weatherOutputTurn()]);
    const { result } = renderHook(() => useDemoProgress(messages, noBranch, () => undefined, []));
    expect(idsOf(result.current)).not.toContain('server-weather');
  });

  it('does not drop server-weather for a getWeather call still awaiting its output', () => {
    const pending: OpenAIMessage = {
      role: 'assistant',
      items: [{ type: 'function_call', call_id: 'c1', name: 'getWeather', arguments: '{}', status: 'in_progress' }],
    };
    const { result } = renderHook(() => useDemoProgress(paired([pending]), noBranch, () => undefined, []));
    expect(idsOf(result.current)).toContain('server-weather');
  });

  it('drops cancel when a cancel signal is on the channel', () => {
    const ablyMessages = [{ name: EVENT_CANCEL } as Ably.InboundMessage];
    const { result } = renderHook(() => useDemoProgress([], noBranch, () => undefined, ablyMessages));
    expect(idsOf(result.current)).not.toContain('cancel');
  });

  it('drops multi-tab when turns come from more than one client', () => {
    const messages = paired([textTurn('user', 'hi'), textTurn('assistant', 'hello')]);
    const runOf = run({ 'cm-0': 'client-a', 'cm-1': 'client-b' });
    const { result } = renderHook(() => useDemoProgress(messages, noBranch, runOf, []));
    expect(idsOf(result.current)).not.toContain('multi-tab');
  });

  it('drops edit / regenerate when the matching node has siblings', () => {
    const messages = paired([textTurn('user', 'hi'), textTurn('assistant', 'hello')]);
    const branch = (codecMessageId: string): BranchHandle<OpenAIMessage> => ({
      ...noBranch(codecMessageId),
      hasSiblings: true,
    });
    const { result } = renderHook(() => useDemoProgress(messages, branch, () => undefined, []));
    expect(idsOf(result.current)).not.toContain('edit');
    expect(idsOf(result.current)).not.toContain('regenerate');
  });
});
