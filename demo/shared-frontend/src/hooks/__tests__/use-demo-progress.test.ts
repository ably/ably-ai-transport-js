import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { EVENT_CANCEL, type BranchHandle, type CodecMessage, type RunInfo } from '@ably/ai-transport';

import { useDemoProgress } from '../use-demo-progress';
import type { Scenario } from '../../lib/progress-steps';

// useDemoProgress filters a demo's scenario list down to the trackable ones
// (those with an `id`) that are still unfinished, detecting completion from the
// conversation tree, run metadata, branch siblings, and the channel's raw
// messages. These tests pin each built-in completion detector.

// A demo's scenario list: the eight trackable scenarios plus one intro-only
// entry (no id) that is never offered as a chip.
const SCENARIOS: Scenario[] = [
  { id: 'server-weather', tag: 'Server tool', title: 'Server tool call', blurb: 'b', prompt: 'weather in Tokyo?' },
  { id: 'client-weather', tag: 'Client tool', title: 'Client tool call', blurb: 'b', prompt: 'weather here?' },
  { id: 'approval-forecast', tag: 'Approval', title: 'Approval-gated tool', blurb: 'b', prompt: 'forecast?' },
  { id: 'retry-stock', tag: 'Retry', title: 'Durable retry', blurb: 'b', prompt: 'stock price?' },
  { id: 'multi-tab', tag: 'Sync', title: 'Multi-client sync', blurb: 'b', gesture: 'open in a new tab' },
  { id: 'edit', tag: 'Branching', title: 'Edit', blurb: 'b', gesture: 'edit a message' },
  { id: 'regenerate', tag: 'Branching', title: 'Regenerate', blurb: 'b', gesture: 'regenerate a reply' },
  { id: 'cancel', tag: 'Cancel', title: 'Cancel mid-stream', blurb: 'b', gesture: 'stop mid-stream' },
  { tag: 'Observability', title: 'Observability', blurb: 'b', gesture: 'open the Debug pane' },
];

const noBranch = (): BranchHandle<AI.UIMessage> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {},
});

function withSiblings(): BranchHandle<AI.UIMessage> {
  const sib: AI.UIMessage = { id: 's', role: 'user', parts: [] };
  return { hasSiblings: true, siblings: [sib, sib], index: 0, selected: sib, select: () => {} };
}

function completeRun(clientId: string): RunInfo {
  return { runId: `run-${clientId}`, clientId, invocationId: '', steps: [], status: 'complete' };
}

function userTurn(id: string, text = 'hello'): CodecMessage<AI.UIMessage> {
  return { codecMessageId: id, message: { id, role: 'user', parts: [{ type: 'text', text }] } };
}

function assistantTurn(id: string, parts: AI.UIMessage['parts']): CodecMessage<AI.UIMessage> {
  return { codecMessageId: id, message: { id, role: 'assistant', parts } };
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

// CAST: the hook reads only `.name` off each inbound message; build the minimal
// shape and assert the InboundMessage type.
function cancelMessage(): Ably.InboundMessage {
  return { name: EVENT_CANCEL } as Ably.InboundMessage;
}

function progress(
  messages: CodecMessage<AI.UIMessage>[],
  opts: {
    branchSelection?: (id: string) => BranchHandle<AI.UIMessage>;
    runOf?: (id: string) => RunInfo | undefined;
    ablyMessages?: Ably.InboundMessage[];
    scenarios?: Scenario[];
  } = {},
): Scenario[] {
  const branchSelection = opts.branchSelection ?? noBranch;
  const runOf = opts.runOf ?? (() => undefined);
  const ablyMessages = opts.ablyMessages ?? [];
  const scenarios = opts.scenarios ?? SCENARIOS;
  return renderHook(() => useDemoProgress(scenarios, messages, branchSelection, runOf, ablyMessages)).result.current;
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
      'edit',
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
    expect(ids(progress([], { ablyMessages: [cancelMessage()] }))).not.toContain('cancel');
  });

  it('marks multi-tab done when runs from more than one client appear', () => {
    const messages = [userTurn('u1'), userTurn('u2')];
    const runOf = (id: string): RunInfo | undefined =>
      id === 'u1' ? completeRun('client-a') : completeRun('client-b');
    expect(ids(progress(messages, { runOf }))).not.toContain('multi-tab');
  });

  it('keeps multi-tab while every run belongs to a single client', () => {
    const messages = [userTurn('u1'), userTurn('u2')];
    const runOf = (): RunInfo | undefined => completeRun('client-a');
    expect(ids(progress(messages, { runOf }))).toContain('multi-tab');
  });

  it('marks regenerate done when an assistant message has siblings', () => {
    const messages = [userTurn('u1'), assistantTurn('a1', [{ type: 'text', text: 'hi' }])];
    const branchSelection = (id: string): BranchHandle<AI.UIMessage> => (id === 'a1' ? withSiblings() : noBranch());
    expect(ids(progress(messages, { branchSelection }))).not.toContain('regenerate');
  });

  it('marks edit done when a user message has siblings', () => {
    const messages = [userTurn('u1'), assistantTurn('a1', [{ type: 'text', text: 'hi' }])];
    const branchSelection = (id: string): BranchHandle<AI.UIMessage> => (id === 'u1' ? withSiblings() : noBranch());
    expect(ids(progress(messages, { branchSelection }))).not.toContain('edit');
  });
});
