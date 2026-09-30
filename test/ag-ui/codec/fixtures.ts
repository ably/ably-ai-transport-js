/**
 * AG-UI event streams for the codec suites: a text run, a tool-calling run, a
 * reasoning run, a run streamed as chunks, and the events that travel whole.
 */

import type * as AGUI from '@ag-ui/core';
import { EventType } from '@ag-ui/core';

import type { AGUIEvent } from '../../../src/ag-ui/index.js';

/** The history a client already holds, repeated on a run's input. */
export const history: AGUI.Message[] = [
  { id: 'u0', role: 'user', content: 'Hello' },
  { id: 'a0', role: 'assistant', content: 'Hi, how can I help?' },
];

/** A run's input, as a client sends it and as `RUN_STARTED` repeats it. */
export const runInput: AGUI.RunAgentInput = {
  threadId: 'th1',
  runId: 'r1',
  messages: [...history, { id: 'u1', role: 'user', content: 'What is the weather in London?' }],
  tools: [{ name: 'weather', description: 'The weather in a city' }],
  context: [{ description: 'units', value: 'metric' }],
  state: { step: 0 },
};

/** A run that answers in three text deltas, with metadata on its end. */
export const textRun: AGUIEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 'th1', runId: 'r1', input: runInput },
  { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'It is ', timestamp: 1 },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: '21°C in ', timestamp: 2 },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'London.', timestamp: 3 },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'm1', metadata: { model: 'm-1' } },
  { type: EventType.RUN_FINISHED, threadId: 'th1', runId: 'r1' },
];

/** A run that calls a tool, streams its arguments and publishes its result. */
export const toolRun: AGUIEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 'th1', runId: 'r2' },
  { type: EventType.TOOL_CALL_START, toolCallId: 't1', toolCallName: 'weather', parentMessageId: 'm2' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '{"city":' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 't1', delta: '"London"}' },
  { type: EventType.TOOL_CALL_END, toolCallId: 't1' },
  { type: EventType.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 't1', content: '{"temp":21}', role: 'tool' },
  { type: EventType.RUN_FINISHED, threadId: 'th1', runId: 'r2' },
];

/** A run that reasons before it answers, with the reasoning and the answer under one id. */
export const reasoningRun: AGUIEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 'th1', runId: 'r3' },
  { type: EventType.REASONING_START, messageId: 'm3' },
  { type: EventType.REASONING_MESSAGE_START, messageId: 'm3', role: 'reasoning' },
  { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'm3', delta: 'The user ' },
  { type: EventType.TEXT_MESSAGE_START, messageId: 'm3' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm3', delta: 'Let me ' },
  { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'm3', delta: 'wants weather.' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm3', delta: 'check.' },
  { type: EventType.REASONING_MESSAGE_END, messageId: 'm3' },
  { type: EventType.REASONING_END, messageId: 'm3' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'm3' },
  { type: EventType.RUN_FINISHED, threadId: 'th1', runId: 'r3' },
];

/**
 * A run streamed as chunks. Each stream's first chunk carries the fields that
 * open it, and the chunks after it carry the id and a delta, which is how
 * AG-UI's `transformChunks` expects them.
 */
export const chunkRun: AGUIEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 'th1', runId: 'r4' },
  { type: EventType.TOOL_CALL_CHUNK, toolCallId: 't2', toolCallName: 'weather', parentMessageId: 'm4', delta: '{"ci' },
  { type: EventType.TOOL_CALL_CHUNK, toolCallId: 't2', delta: 'ty":"Par' },
  { type: EventType.TOOL_CALL_CHUNK, toolCallId: 't2', delta: 'is"}' },
  { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm5', role: 'assistant', delta: 'Paris ' },
  { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm5', delta: 'is ' },
  { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'm5', delta: 'sunny.' },
  { type: EventType.RUN_FINISHED, threadId: 'th1', runId: 'r4' },
];

/** One of each event that travels whole and is in no fixture run above. */
export const wholeEvents: AGUIEvent[] = [
  { type: EventType.STEP_STARTED, stepName: 'plan' },
  { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1, todo: ['a'] } },
  { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/step', value: 2 }] },
  { type: EventType.ACTIVITY_SNAPSHOT, messageId: 'act1', activityType: 'plan', content: { done: false } },
  {
    type: EventType.ACTIVITY_DELTA,
    messageId: 'act1',
    activityType: 'plan',
    patch: [{ op: 'add', path: '/done', value: true }],
  },
  { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'm3', encryptedValue: 'xyz' },
  { type: EventType.SUBAGENT_STARTED, subagentRunId: 'sa1', name: 'researcher' },
  { type: EventType.SUBAGENT_FINISHED, subagentRunId: 'sa1' },
  { type: EventType.SUBAGENT_ERROR, subagentRunId: 'sa2', message: 'timed out' },
  { type: EventType.CUSTOM, name: 'progress', value: { percent: 50 } },
  { type: EventType.RAW, event: { provider: 'native' }, source: 'openai' },
  { type: EventType.STEP_FINISHED, stepName: 'plan' },
  { type: EventType.RUN_ERROR, message: 'rate limited', code: '429' },
];

/** A messages snapshot, which the codec never publishes. */
export const messagesSnapshot: AGUIEvent = { type: EventType.MESSAGES_SNAPSHOT, messages: history };

/**
 * The events a subscriber decodes for a run: every event the agent produced
 * except a messages snapshot, with `RUN_STARTED.input.messages` emptied.
 * @param events - The run's events, as the agent produced them.
 * @returns The decoded events.
 */
export const decodedOf = (events: AGUIEvent[]): AGUIEvent[] =>
  events.flatMap((e): AGUIEvent[] => {
    if (e.type === EventType.MESSAGES_SNAPSHOT) return [];
    if (e.type === EventType.RUN_STARTED && e.input !== undefined) {
      return [{ ...e, input: { ...e.input, messages: [] } }];
    }
    return [e];
  });

/**
 * The event at an index, for a test that knows the fixture has one there.
 * @param events - The events.
 * @param index - The index.
 * @returns The event.
 */
export const at = (events: AGUIEvent[], index: number): AGUIEvent => {
  const e = events[index];
  if (e === undefined) throw new Error(`no event at ${String(index)}`);
  return e;
};
