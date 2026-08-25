import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { EVENT_CANCEL, EVENT_RUN_START, HEADER_RUN_CLIENT_ID } from '@ably/ai-transport';

import { useDemoProgress } from '../use-demo-progress';
import type { Scenario } from '../../lib/progress-steps';

// useDemoProgress filters a demo's scenario list down to the trackable ones
// (those with an `id`) that are still unfinished, detecting completion from
// the conversation's tool activity and the channel's raw messages (event
// names + transport headers). These tests pin each built-in detector.

// A demo's scenario list: the eight trackable scenarios plus one intro-only
// entry (no id) that is never offered as a chip.
const SCENARIOS: Scenario[] = [
  { id: 'server-weather', tag: 'Server tool', title: 'Server tool call', blurb: 'b', prompt: 'weather in Tokyo?' },
  { id: 'client-weather', tag: 'Client tool', title: 'Client tool call', blurb: 'b', prompt: 'weather here?' },
  { id: 'approval-forecast', tag: 'Approval', title: 'Approval-gated tool', blurb: 'b', prompt: 'forecast?' },
  { id: 'retry-stock', tag: 'Retry', title: 'Durable retry', blurb: 'b', prompt: 'stock price?' },
  { id: 'multi-tab', tag: 'Sync', title: 'Multi-client sync', blurb: 'b', gesture: 'open in a new tab' },
  { id: 'regenerate', tag: 'Regenerate', title: 'Regenerate', blurb: 'b', gesture: 'regenerate a reply' },
  { id: 'cancel', tag: 'Cancel', title: 'Cancel mid-stream', blurb: 'b', gesture: 'stop mid-stream' },
  { tag: 'Observability', title: 'Observability', blurb: 'b', gesture: 'open the Debug pane' },
];

function userTurn(id: string, text = 'hello'): AI.UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistantTurn(id: string, parts: AI.UIMessage['parts']): AI.UIMessage {
  return { id, role: 'assistant', parts };
}

// CAST: `ToolUIPart` is a discriminated union keyed on `state`; a plain object
// literal can't be inferred as one arm, so build only the fields the hook reads
// (type/state/output) and assert the union type.
function toolPart(name: string, state: 'input-available' | 'output-available'): AI.ToolUIPart {
  return {
    type: `tool-${name}`,
    toolCallId: `${name}-1`,
    state,
    input: {},
    ...(state === 'output-available' ? { output: { ok: true } } : {}),
  } as AI.ToolUIPart;
}

// CAST: the hook reads only `name` and the `extras.ai` header tiers off each
// inbound message; build the minimal shape and assert the type.
function wireMessage(
  name: string | undefined,
  transportHeaders: Record<string, string> = {},
  codecHeaders: Record<string, string> = {},
): Ably.InboundMessage {
  return { name, extras: { ai: { transport: transportHeaders, codec: codecHeaders } } } as Ably.InboundMessage;
}

function progress(
  messages: AI.UIMessage[],
  opts: {
    ablyMessages?: Ably.InboundMessage[];
    scenarios?: Scenario[];
  } = {},
): Scenario[] {
  const ablyMessages = opts.ablyMessages ?? [];
  const scenarios = opts.scenarios ?? SCENARIOS;
  return renderHook(() => useDemoProgress(scenarios, messages, ablyMessages)).result.current;
}

const ids = (result: Scenario[]) => result.map((s) => s.id);

describe('useDemoProgress', () => {
  it('returns only trackable scenarios, in order, dropping intro-only entries (no id)', () => {
    expect(ids(progress([]))).toEqual([
      'server-weather',
      'client-weather',
      'approval-forecast',
      'retry-stock',
      'multi-tab',
      'regenerate',
      'cancel',
    ]);
  });

  it('marks server-weather done when a turn produces a getWeather output without getLocation', () => {
    const messages = [userTurn('u1'), assistantTurn('a1', [toolPart('getWeather', 'output-available')])];
    expect(ids(progress(messages))).not.toContain('server-weather');
  });

  it('keeps server-weather while getWeather has no output yet', () => {
    const messages = [userTurn('u1'), assistantTurn('a1', [toolPart('getWeather', 'input-available')])];
    expect(ids(progress(messages))).toContain('server-weather');
  });

  it('marks client-weather (not server-weather) when a turn calls getLocation before getWeather', () => {
    const messages = [
      userTurn('u1'),
      assistantTurn('a1', [toolPart('getLocation', 'output-available'), toolPart('getWeather', 'output-available')]),
    ];
    const result = ids(progress(messages));
    expect(result).not.toContain('client-weather');
    expect(result).toContain('server-weather');
  });

  it('marks approval-forecast done when a turn produces a getWeatherForecast output', () => {
    const messages = [userTurn('u1'), assistantTurn('a1', [toolPart('getWeatherForecast', 'output-available')])];
    expect(ids(progress(messages))).not.toContain('approval-forecast');
  });

  it('marks retry-stock done when a turn produces a getStockPrice output', () => {
    const messages = [userTurn('u1'), assistantTurn('a1', [toolPart('getStockPrice', 'output-available')])];
    expect(ids(progress(messages))).not.toContain('retry-stock');
  });

  it('marks cancel done when an ai-cancel message appears on the channel', () => {
    expect(ids(progress([], { ablyMessages: [wireMessage(EVENT_CANCEL)] }))).not.toContain('cancel');
  });

  it('marks regenerate done when an input carries the codec-tier regenerate kind', () => {
    const ablyMessages = [wireMessage('ai-input', {}, { kind: 'regenerate' })];
    expect(ids(progress([], { ablyMessages }))).not.toContain('regenerate');
  });

  it('marks multi-tab done when ai-run-start messages carry more than one run-client-id', () => {
    const ablyMessages = [
      wireMessage(EVENT_RUN_START, { [HEADER_RUN_CLIENT_ID]: 'client-a' }),
      wireMessage(EVENT_RUN_START, { [HEADER_RUN_CLIENT_ID]: 'client-b' }),
    ];
    expect(ids(progress([], { ablyMessages }))).not.toContain('multi-tab');
  });

  it('keeps multi-tab while every run starts from a single client', () => {
    const ablyMessages = [
      wireMessage(EVENT_RUN_START, { [HEADER_RUN_CLIENT_ID]: 'client-a' }),
      wireMessage(EVENT_RUN_START, { [HEADER_RUN_CLIENT_ID]: 'client-a' }),
    ];
    expect(ids(progress([], { ablyMessages }))).toContain('multi-tab');
  });

  it('ignores run-client-id headers on messages that are not ai-run-start', () => {
    const ablyMessages = [
      wireMessage(EVENT_RUN_START, { [HEADER_RUN_CLIENT_ID]: 'client-a' }),
      wireMessage('ai-output', { [HEADER_RUN_CLIENT_ID]: 'client-b' }),
    ];
    expect(ids(progress([], { ablyMessages }))).toContain('multi-tab');
  });

  it('handles wire messages with no extras.ai envelope', () => {
    // CAST: a foreign message published by the application carries no extras.
    const foreign = { name: 'app-event' } as Ably.InboundMessage;
    expect(ids(progress([], { ablyMessages: [foreign] }))).toContain('regenerate');
  });
});
