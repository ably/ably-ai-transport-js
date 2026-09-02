/**
 * Tests for the thread merge — the demo's obligations over the SDK's decoded
 * event stream: seeding OpenAI's accumulator without `response.created`,
 * output-index bookkeeping, collapsing the decoder's synthesised duplicate
 * openers, merging reduced `output_item.done` items, and the tool/input apply
 * steps. Fixtures mirror the exact shapes the codec's decoder hands out
 * (see `src/openai/codec/descriptors.ts` in the SDK): rebuilt deltas carry
 * `item_id`/`content_index` but no `output_index`, discrete item envelopes
 * carry no `output_index`, and nothing carries `sequence_number`.
 */

import { describe, expect, it } from 'vitest';
import * as Ably from 'ably';
import type { TransportEvent, WireMeta } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIInput, OpenAIMessage } from '../openai-thread';
import type { Responses } from 'openai/resources/responses/responses';

import { createThreadMerge } from '../merge-thread';
import { turnText } from '../../helpers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Event = TransportEvent<OpenAIInput, OpenAIOutput>;

const makeMeta = (overrides: Partial<WireMeta>): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: 's-1',
  transportMessageId: undefined,
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: 1,
  role: undefined,
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  inputTransportMessageId: undefined,
  inputTransportMessageIds: undefined,
  steerTransportMessageIds: undefined,
  ...overrides,
});

const outputEvent = (transportMessageId: string, outputs: OpenAIOutput[], meta: Partial<WireMeta> = {}): Event => ({
  kind: 'message',
  meta: makeMeta({ transportMessageId, role: 'assistant', runId: 'r1', ...meta }),
  inputs: [],
  outputs,
});

const inputEvent = (transportMessageId: string, inputs: OpenAIInput[], meta: Partial<WireMeta> = {}): Event => ({
  kind: 'message',
  meta: makeMeta({ transportMessageId, role: 'user', ...meta }),
  inputs,
  outputs: [],
});

// Decoded-output builders. Each mirrors the shape the SDK decoder actually
// emits for that event; the CASTs cover the fields the SDK's output type keeps
// for genuine agent-published passthrough (sequence_number, delta logprobs)
// that the decoder's rebuilt events do not carry at runtime.

const messageItem = (id: string): Responses.ResponseOutputMessage => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [],
});

const reasoningItem = (id: string): Responses.ResponseReasoningItem => ({ id, type: 'reasoning', summary: [] });

const fnCallItem = (id: string, callId: string, name: string, args: string): Responses.ResponseFunctionToolCall => ({
  id,
  type: 'function_call',
  call_id: callId,
  name,
  arguments: args,
  status: 'in_progress',
});

// The discrete item envelope and the decode-lifecycle synthesis both decode to
// { type, item, output_index? } with no sequence_number.
const itemAdded = (item: Responses.ResponseOutputItem, outputIndex = 0): OpenAIOutput =>
  // CAST: mirrors the decoded event, which carries no sequence_number.
  ({ type: 'response.output_item.added', item, output_index: outputIndex }) as OpenAIOutput;

// The reduced wire-form done item: status plus residue only, no content echo.
const itemDone = (
  item: { type: 'message' | 'reasoning' | 'function_call'; id: string } & Record<string, unknown>,
): OpenAIOutput =>
  // CAST: mirrors the decoded event: a reduced WireDoneItem, no output_index.
  ({ type: 'response.output_item.done', item }) as unknown as OpenAIOutput;

const partAdded = (itemId: string, outputIndex: number, contentIndex: number): OpenAIOutput =>
  // CAST: mirrors the decoded stream start (all declared fields, no sequence_number).
  ({
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    part: { type: 'output_text', text: '', annotations: [] },
  }) as unknown as OpenAIOutput;

const textDelta = (itemId: string, contentIndex: number, delta: string): OpenAIOutput =>
  // CAST: mirrors the decoded delta rebuild — item_id + content_index + delta,
  // no output_index, no sequence_number, no logprobs.
  ({ type: 'response.output_text.delta', item_id: itemId, content_index: contentIndex, delta }) as OpenAIOutput;

const textDone = (itemId: string, outputIndex: number, contentIndex: number, text: string): OpenAIOutput =>
  // CAST: mirrors the decoded end rebuild — no sequence_number, no logprobs.
  ({
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: outputIndex,
    content_index: contentIndex,
    text,
  }) as OpenAIOutput;

const summaryPartAdded = (itemId: string, outputIndex: number, summaryIndex: number): OpenAIOutput =>
  // CAST: mirrors the decoded reasoning-summary stream start.
  ({
    type: 'response.reasoning_summary_part.added',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: summaryIndex,
    part: { type: 'summary_text', text: '' },
  }) as OpenAIOutput;

const summaryDelta = (itemId: string, summaryIndex: number, delta: string): OpenAIOutput =>
  // CAST: mirrors the decoded delta rebuild — item_id + summary_index + delta.
  ({
    type: 'response.reasoning_summary_text.delta',
    item_id: itemId,
    summary_index: summaryIndex,
    delta,
  }) as OpenAIOutput;

const argsDelta = (itemId: string, outputIndex: number, delta: string): OpenAIOutput =>
  // CAST: mirrors the decoded fn-args delta — item_id from the item envelope header.
  ({
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  }) as OpenAIOutput;

const argsDone = (itemId: string, outputIndex: number, args: string, name: string): OpenAIOutput =>
  // CAST: mirrors the decoded fn-args end rebuild.
  ({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
    name,
  }) as OpenAIOutput;

const userTurnInput = (text: string): OpenAIInput => ({
  kind: 'message',
  payload: { role: 'user', items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] },
});

const runStart = (runId: string, inputTransportMessageId?: string): Event => ({
  kind: 'run-lifecycle',
  event: {
    type: 'start',
    runId,
    clientId: 'agent',
    invocationId: 'inv-1',
    serial: 's-run',
    ...(inputTransportMessageId !== undefined && { inputTransportMessageId }),
  },
});

const runLifecycle = (type: 'suspend' | 'resume', runId: string): Event => ({
  kind: 'run-lifecycle',
  event: { type, runId, clientId: 'agent', invocationId: 'inv-1', serial: 's-run' },
});

const runEnd = (runId: string, reason: 'complete' | 'cancelled'): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'end', runId, clientId: 'agent', invocationId: 'inv-1', serial: 's-run', reason },
});

/**
 * The decoded wire sequence for one streamed assistant text message, one
 * TransportEvent per wire message, as the SDK hands it out: the discrete
 * `output_item.added`, then the stream start (with the decode-lifecycle's
 * unconditionally synthesised opening bracket prepended), the deltas, the
 * rebuilt close, and the reduced `output_item.done`.
 */
const streamedText = (transportMessageId: string, itemId: string, pieces: string[]): Event[] => [
  outputEvent(transportMessageId, [itemAdded(messageItem(itemId))]),
  outputEvent(transportMessageId, [itemAdded(messageItem(itemId)), partAdded(itemId, 0, 0)]),
  ...pieces.map((piece) => outputEvent(transportMessageId, [textDelta(itemId, 0, piece)])),
  outputEvent(transportMessageId, [textDone(itemId, 0, 0, pieces.join(''))]),
  outputEvent(transportMessageId, [itemDone({ type: 'message', id: itemId, status: 'completed' })]),
];

const mergeAll = (events: Event[]) => {
  const merge = createThreadMerge();
  for (const event of events) merge.apply(event);
  return merge;
};

const messageText = (message: OpenAIMessage): string =>
  message.items
    .map((item) =>
      item.type === 'message' && Array.isArray(item.content)
        ? item.content.map((part) => ('text' in part ? part.text : '')).join('')
        : '',
    )
    .join('');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createThreadMerge', () => {
  it('merges a full streamed text message through the accumulator without response.created', () => {
    const merge = mergeAll(streamedText('m1', 'i1', ['Hello, ', 'world']));
    const messages = merge.messages();
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.transportMessageId).toBe('m1');
    expect(message.role).toBe('assistant');
    expect(message.runId).toBe('r1');
    expect(message.items).toHaveLength(1);
    const item = message.items[0];
    expect(item.type).toBe('message');
    expect(messageText(message)).toBe('Hello, world');
    // The reduced done finalised the accumulated item rather than replacing it.
    expect(item.type === 'message' ? item.status : undefined).toBe('completed');
  });

  it('collapses the synthesised duplicate output_item.added by item id', () => {
    // streamedText already carries the duplicate (the stream start's
    // synthesised bracket); assert it produced ONE item, not two.
    const merge = mergeAll(streamedText('m1', 'i1', ['hi']));
    expect(merge.messages()[0].items).toHaveLength(1);
  });

  it('merges a reduced output_item.done (status + logprobs residue) instead of replacing the item', () => {
    const logprobs = [{ token: 'hi', logprob: -0.1, top_logprobs: [], bytes: [] }];
    const events = [
      outputEvent('m1', [itemAdded(messageItem('i1')), partAdded('i1', 0, 0)]),
      outputEvent('m1', [textDelta('i1', 0, 'hi')]),
      outputEvent('m1', [textDone('i1', 0, 0, 'hi')]),
      outputEvent('m1', [
        itemDone({ type: 'message', id: 'i1', status: 'completed', content: [{ type: 'output_text', logprobs }] }),
      ]),
    ];
    const message = mergeAll(events).messages()[0];
    const item = message.items[0];
    if (item.type !== 'message' || item.content[0]?.type !== 'output_text') throw new Error('expected a text message');
    // Replaying the reduced done verbatim would erase the streamed text.
    expect(item.content[0].text).toBe('hi');
    expect(item.status).toBe('completed');
    expect(item.content[0].logprobs).toEqual(logprobs);
  });

  it('merges a reasoning done item, keeping the streamed summary and merging encrypted_content', () => {
    const events = [
      outputEvent('m1', [itemAdded(reasoningItem('rs1')), summaryPartAdded('rs1', 0, 0)]),
      outputEvent('m1', [summaryDelta('rs1', 0, 'thinking...')]),
      outputEvent('m1', [itemDone({ type: 'reasoning', id: 'rs1', encrypted_content: 'blob' })]),
    ];
    const item = mergeAll(events).messages()[0].items[0];
    if (item.type !== 'reasoning') throw new Error('expected a reasoning item');
    expect(item.summary[0]?.text).toBe('thinking...');
    expect(item.encrypted_content).toBe('blob');
  });

  it('merges a function-call arguments stream and its reduced done', () => {
    const events = [
      outputEvent('m1', [itemAdded(fnCallItem('fc1', 'call-1', 'getWeather', ''))]),
      outputEvent('m1', [argsDelta('fc1', 0, '{"location":')]),
      outputEvent('m1', [argsDelta('fc1', 0, '"Tokyo"}')]),
      outputEvent('m1', [argsDone('fc1', 0, '{"location":"Tokyo"}', 'getWeather')]),
      outputEvent('m1', [itemDone({ type: 'function_call', id: 'fc1', status: 'completed' })]),
    ];
    const item = mergeAll(events).messages()[0].items[0];
    if (item.type !== 'function_call') throw new Error('expected a function_call item');
    expect(item.arguments).toBe('{"location":"Tokyo"}');
    expect(item.status).toBe('completed');
  });

  it('mid-run reload: partial history plus the live continuation merge to ONE message', () => {
    const itemId = 'i1';
    // History, decoded from the channel: the real opener and the first deltas.
    const history = [
      outputEvent('m1', [itemAdded(messageItem(itemId))]),
      outputEvent('m1', [itemAdded(messageItem(itemId)), partAdded(itemId, 0, 0)]),
      outputEvent('m1', [textDelta(itemId, 0, 'Once upon ')]),
    ];
    // Live, joined mid-stream: the decoder synthesises the opening bracket and
    // rebuilds the part opener before the remaining deltas.
    const live = [
      outputEvent('m1', [itemAdded(messageItem(itemId)), partAdded(itemId, 0, 0), textDelta(itemId, 0, 'a time, ')]),
      outputEvent('m1', [textDelta(itemId, 0, 'the end.')]),
      outputEvent('m1', [textDone(itemId, 0, 0, 'Once upon a time, the end.')]),
      outputEvent('m1', [itemDone({ type: 'message', id: itemId, status: 'completed' })]),
    ];
    const merge = mergeAll([...history, ...live]);
    const messages = merge.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0].items).toHaveLength(1);
    expect(messageText(messages[0])).toBe('Once upon a time, the end.');
  });

  it('multi-batch history merges identically to a single batch', () => {
    const events = [
      inputEvent('m0', [userTurnInput('hi')]),
      runStart('r1', 'm0'),
      ...streamedText('m1', 'i1', ['Hello, ', 'world']),
      runEnd('r1', 'complete'),
    ];
    // history() returns each next OLDER slice; the consumer prepends. Split at
    // an arbitrary boundary and reassemble the way the hooks do.
    const newerBatch = events.slice(4);
    const olderBatch = events.slice(0, 4);
    const reassembled = [...olderBatch, ...newerBatch];
    expect(mergeAll(reassembled).messages()).toEqual(mergeAll(events).messages());
  });

  it('dedupes identical parts a redelivered wire event repeats under one transport-message-id', () => {
    const events = [
      inputEvent('m0', [userTurnInput('hi')], { serial: 's-1', clientId: 'client-a' }),
      // A redelivered event repeats the same turn verbatim.
      inputEvent('m0', [userTurnInput('hi')], { serial: 's-2', clientId: 'client-a' }),
    ];
    const messages = mergeAll(events).messages();
    expect(messages).toHaveLength(1);
    const item = messages[0].items[0];
    if (item?.type !== 'message') throw new Error('expected a message item');
    expect(item.content).toHaveLength(1);
    expect(messages[0].clientId).toBe('client-a');
  });

  it('dedupes two deliveries whose keys come back in a different order', () => {
    // A redelivered wire event comes back through the codec's decode, which
    // builds its fields in its own order. A serialised comparison reads the
    // two deliveries as two parts and the text renders as "hihi".
    const first = userTurnInput('hi');
    const decoded: OpenAIInput = {
      kind: 'message',
      // CAST: the same shape as userTurnInput's, with the part's keys reversed.
      payload: {
        role: 'user',
        items: [{ type: 'message', role: 'user', content: [{ text: 'hi', type: 'input_text' }] }],
      },
    };
    const events = [
      inputEvent('m0', [first], { serial: 's-1', clientId: 'client-a' }),
      inputEvent('m0', [decoded], { serial: 's-2', clientId: 'client-a' }),
    ];

    const messages = mergeAll(events).messages();
    expect(messages).toHaveLength(1);
    const item = messages[0].items[0];
    if (item?.type !== 'message') throw new Error('expected a message item');
    expect(item.content).toHaveLength(1);
    expect(turnText(messages[0])).toBe('hi');
  });

  it('appends distinct parts of the same message across deliveries', () => {
    const events = [inputEvent('m0', [userTurnInput('part one. ')]), inputEvent('m0', [userTurnInput('part two.')])];
    const item = mergeAll(events).messages()[0].items[0];
    if (item?.type !== 'message') throw new Error('expected a message item');
    expect(item.content).toHaveLength(2);
  });

  it('merges a tool-approval-request into pending state and an approval input into a decision', () => {
    const request: OpenAIOutput = {
      type: 'tool-approval-request',
      call_id: 'call-1',
      name: 'getWeatherForecast',
      arguments: '{"location":"Paris"}',
    };
    const events = [
      outputEvent('m1', [itemAdded(fnCallItem('fc1', 'call-1', 'getWeatherForecast', '{}'))]),
      outputEvent('m1', [request]),
    ];
    const pending = mergeAll(events).messages()[0];
    expect(pending.toolCallStates?.['call-1']).toEqual({
      approval: 'pending',
      name: 'getWeatherForecast',
      arguments: '{"location":"Paris"}',
    });

    const denied = mergeAll([
      ...events,
      inputEvent('m1', [{ kind: 'approval', payload: { call_id: 'call-1', approved: false, reason: 'User denied' } }]),
    ]).messages()[0];
    expect(denied.toolCallStates?.['call-1']?.approval).toBe('denied');
    expect(denied.toolCallStates?.['call-1']?.reason).toBe('User denied');
  });

  it('appends function_call_output events and item inputs, deduping by call_id', () => {
    const fco: Responses.ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{"temperature":20}',
    };
    const events = [
      outputEvent('m1', [itemAdded(fnCallItem('fc1', 'call-1', 'getWeather', '{}'))]),
      // The agent's own output event, then a redundant client item input for
      // the same call: one output must survive.
      outputEvent('m2', [{ type: 'function_call_output', item: fco }]),
      inputEvent('m2', [{ kind: 'item', payload: fco }]),
    ];
    const messages = mergeAll(events).messages();
    expect(messages).toHaveLength(2);
    expect(messages[1].items).toEqual([fco]);
  });

  it('orders a client tool result after the message it amends', () => {
    const fco: Responses.ResponseInputItem.FunctionCallOutput = {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{"latitude":51.5}',
    };
    const events = [
      outputEvent('m1', [itemAdded(fnCallItem('fc1', 'call-1', 'getLocation', '{}'))]),
      outputEvent('m1', [itemDone({ type: 'function_call', id: 'fc1', status: 'completed' })]),
      // The client's resolution amends the assistant message by transport-message-id.
      inputEvent('m1', [{ kind: 'item', payload: fco }]),
    ];
    const items = mergeAll(events).messages()[0].items;
    expect(items.map((item) => item.type)).toEqual(['function_call', 'function_call_output']);
  });

  it('tracks run lifecycle: start/resume are running, suspend and end are not', () => {
    const merge = createThreadMerge();
    expect(merge.isRunning()).toBe(false);

    merge.apply(runStart('r1', 'm0'));
    expect(merge.isRunning()).toBe(true);
    expect(merge.activeRunId()).toBe('r1');
    expect(merge.runs().get('r1')).toEqual({ status: 'active', inputTransportMessageId: 'm0' });

    merge.apply(runLifecycle('suspend', 'r1'));
    expect(merge.isRunning()).toBe(false);
    expect(merge.runs().get('r1')?.status).toBe('suspended');

    merge.apply(runLifecycle('resume', 'r1'));
    expect(merge.isRunning()).toBe(true);

    merge.apply(runEnd('r1', 'complete'));
    expect(merge.isRunning()).toBe(false);
    expect(merge.runs().get('r1')?.status).toBe('complete');
    // The trigger stamp survives the lifecycle transitions.
    expect(merge.runs().get('r1')?.inputTransportMessageId).toBe('m0');
  });

  it('records the terminal error message on an errored run-end', () => {
    const merge = createThreadMerge();
    merge.apply(runStart('r1'));
    merge.apply({
      kind: 'run-lifecycle',
      event: {
        type: 'end',
        runId: 'r1',
        clientId: 'agent',
        invocationId: 'inv-1',
        serial: 's-run',
        reason: 'error',
        error: new Ably.ErrorInfo('model exploded', 104008, 500),
      },
    });
    expect(merge.runs().get('r1')).toEqual({ status: 'error', errorMessage: 'model exploded' });
  });

  it('throws (rather than silently dropping content) on a stream event whose item was never opened', () => {
    const merge = createThreadMerge();
    expect(() => {
      merge.apply(outputEvent('m1', [textDelta('never-opened', 0, 'lost')]));
    }).toThrow(/no accumulated item for item_id never-opened/);
  });

  it('ignores foreign carriers: no transport-message-id, or no decoded events', () => {
    const merge = createThreadMerge();
    merge.apply({ kind: 'message', meta: makeMeta({}), inputs: [], outputs: [] });
    merge.apply({
      kind: 'message',
      meta: makeMeta({ transportMessageId: 'm9', runId: 'r9' }),
      inputs: [],
      outputs: [],
    });
    expect(merge.messages()).toEqual([]);
  });
});

describe('createThreadMerge().seed', () => {
  it('adopts stored messages so they need no replay', () => {
    const merge = createThreadMerge();

    merge.seed({
      messages: [
        { transportMessageId: 'cm-u1', role: 'user', items: [{ type: 'message', role: 'user', content: [] }] },
        { transportMessageId: 'cm-a1', role: 'assistant', items: [messageItem('i-a1')], runId: 'r1' },
      ],
    });

    expect(merge.messages().map((m) => m.transportMessageId)).toEqual(['cm-u1', 'cm-a1']);
    expect(merge.messages()[1]?.items).toEqual([messageItem('i-a1')]);
    // Seeding carries no run state: the runs a seeded thread came from have
    // ended, and `runs()` reports what this merge has seen happen since.
    expect([...merge.runs()]).toEqual([]);
    expect(merge.activeRunId()).toBeUndefined();
    expect(merge.isRunning()).toBe(false);
  });

  it('leaves a seeded output item addressable, so a later delta lands on it', () => {
    const merge = createThreadMerge();
    // The store holds an assistant message whose text part is already open.
    merge.seed({
      messages: [
        {
          transportMessageId: 'cm-a1',
          role: 'assistant',
          items: [{ ...messageItem('i-a1'), content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }],
        },
      ],
    });

    merge.apply(outputEvent('cm-a1', [textDelta('i-a1', 0, ' there')]));

    expect(turnText(merge.messages()[0])).toBe('Hello there');
  });

  it('continues a seeded message rather than starting a second one for the same id', () => {
    const merge = createThreadMerge();
    merge.seed({
      messages: [{ transportMessageId: 'cm-a1', role: 'assistant', items: [messageItem('i-a1')] }],
    });

    merge.apply(outputEvent('cm-a1', [itemAdded(reasoningItem('i-r1'), 1)]));

    expect(merge.messages()).toHaveLength(1);
    expect(merge.messages()[0]?.items.map((item) => item.type)).toEqual(['message', 'reasoning']);
  });

  it('keeps a stored tool output, which is not an accumulator item', () => {
    const merge = createThreadMerge();
    const output = { type: 'function_call_output' as const, call_id: 'c1', output: '{"ok":true}' };

    merge.seed({
      messages: [{ transportMessageId: 'cm-t1', role: 'assistant', items: [output] }],
    });

    expect(merge.messages()[0]?.items).toEqual([output]);
  });

  it('carries stored tool-call state through', () => {
    const merge = createThreadMerge();

    merge.seed({
      messages: [
        {
          transportMessageId: 'cm-a1',
          role: 'assistant',
          items: [fnCallItem('i-f1', 'c1', 'getWeather', '{}')],
          toolCallStates: { c1: { approval: 'approved' } },
        },
      ],
    });

    expect(merge.messages()[0]?.toolCallStates).toEqual({ c1: { approval: 'approved' } });
  });
});
