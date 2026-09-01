import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as Ably from 'ably';
import { EVENT_CANCEL } from '@ably/ai-transport';

import { useDemoProgress } from '../use-demo-progress';
import type { DemoStepId, Scenario } from '@ably-ai-demos/frontend/lib/progress-steps';
import type { ThreadMessage } from '../../lib/merge-thread';
import { DEMO_SCENARIOS } from '../../lib/intro-content';

// --- fixtures ----------------------------------------------------------------

let nextId = 0;
const asThread = (message: Omit<ThreadMessage, 'codecMessageId'>): ThreadMessage => ({
  codecMessageId: `cm-${nextId++}`,
  ...message,
});

const textTurn = (role: 'user' | 'assistant', text: string, clientId?: string): ThreadMessage =>
  asThread({
    role,
    ...(clientId !== undefined && { clientId }),
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
const weatherTurn = (): ThreadMessage =>
  asThread({
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
const weatherCallTurn = (): ThreadMessage =>
  asThread({
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
const weatherOutputTurn = (): ThreadMessage =>
  asThread({
    role: 'assistant',
    items: [{ type: 'function_call_output', call_id: 'c1', output: '{"temperature":60}' }],
  });

// An assistant turn that ran the getLocation client tool: the call paired with
// a client-published output.
const locationTurn = (): ThreadMessage =>
  asThread({
    role: 'assistant',
    items: [
      { type: 'function_call', call_id: 'c1', name: 'getLocation', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'c1', output: '{"latitude":51.5,"longitude":-0.1}' },
    ],
  });

// An assistant turn whose getWeatherForecast call reached an approval decision,
// carried in toolCallStates but with no output yet (approved, not yet run).
const approvedForecastTurn = (): ThreadMessage =>
  asThread({
    role: 'assistant',
    items: [
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'getWeatherForecast',
        arguments: '{"location":"Paris"}',
        status: 'completed',
      },
    ],
    toolCallStates: { c1: { approval: 'approved' } },
  });

const idsOf = (scenarios: Scenario[]): (DemoStepId | undefined)[] => scenarios.map((s) => s.id);

// --- tests -------------------------------------------------------------------

describe('useDemoProgress', () => {
  it('lists every step when nothing has been demonstrated', () => {
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, [], []));
    expect(idsOf(result.current)).toEqual([
      'server-weather',
      'client-weather',
      'approval-forecast',
      'multi-tab',
      'cancel',
    ]);
  });

  it('drops server-weather once a getWeather tool turn is present', () => {
    const messages = [textTurn('user', "what's the weather in Tokyo?"), weatherTurn()];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, messages, []));
    expect(idsOf(result.current)).not.toContain('server-weather');
  });

  it('drops server-weather when the call and its output are in separate messages', () => {
    const messages = [textTurn('user', "what's the weather in Tokyo?"), weatherCallTurn(), weatherOutputTurn()];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, messages, []));
    expect(idsOf(result.current)).not.toContain('server-weather');
  });

  it('does not drop server-weather for a getWeather call still awaiting its output', () => {
    const pending = asThread({
      role: 'assistant',
      items: [{ type: 'function_call', call_id: 'c1', name: 'getWeather', arguments: '{}', status: 'in_progress' }],
    });
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, [pending], []));
    expect(idsOf(result.current)).toContain('server-weather');
  });

  it('drops client-weather once a getLocation tool turn is present', () => {
    const messages = [textTurn('user', 'where am I?'), locationTurn()];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, messages, []));
    expect(idsOf(result.current)).not.toContain('client-weather');
  });

  it('drops approval-forecast once a getWeatherForecast call reaches an approval decision', () => {
    const messages = [textTurn('user', 'forecast for Paris?'), approvedForecastTurn()];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, messages, []));
    expect(idsOf(result.current)).not.toContain('approval-forecast');
  });

  it('does not drop approval-forecast for a getWeatherForecast call still awaiting a decision', () => {
    const pending = asThread({
      role: 'assistant',
      items: [
        { type: 'function_call', call_id: 'c1', name: 'getWeatherForecast', arguments: '{}', status: 'completed' },
      ],
    });
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, [pending], []));
    expect(idsOf(result.current)).toContain('approval-forecast');
  });

  it('does not drop approval-forecast while the approval is only pending', () => {
    // The merge marks a call 'pending' the moment its approval request lands,
    // so a truthiness test would retire the chip before the user decides.
    const pending = asThread({
      role: 'assistant',
      items: [
        { type: 'function_call', call_id: 'c1', name: 'getWeatherForecast', arguments: '{}', status: 'completed' },
      ],
      toolCallStates: { c1: { approval: 'pending' } },
    });
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, [pending], []));
    expect(idsOf(result.current)).toContain('approval-forecast');
  });

  it('drops cancel when a cancel signal is on the channel', () => {
    const ablyMessages = [{ name: EVENT_CANCEL } as Ably.InboundMessage];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, [], ablyMessages));
    expect(idsOf(result.current)).not.toContain('cancel');
  });

  it('drops multi-tab when user turns come from more than one client', () => {
    const messages = [textTurn('user', 'hi', 'client-a'), textTurn('user', 'hello again', 'client-b')];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, messages, []));
    expect(idsOf(result.current)).not.toContain('multi-tab');
  });

  it('keeps multi-tab while every user turn comes from one client', () => {
    const messages = [textTurn('user', 'hi', 'client-a'), textTurn('user', 'more', 'client-a')];
    const { result } = renderHook(() => useDemoProgress(DEMO_SCENARIOS, messages, []));
    expect(idsOf(result.current)).toContain('multi-tab');
  });
});
