import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Responses } from 'openai/resources/responses/responses';

import { SUPPORTED_EVENT_TYPES, filterSupportedEvents } from '../supported-events';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

/** Push events through the filter transform and collect what survives. */
async function runThrough(events: ResponseStreamEvent[]): Promise<ResponseStreamEvent[]> {
  const source = new ReadableStream<ResponseStreamEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
  const out: ResponseStreamEvent[] = [];
  const reader = source.pipeThrough(filterSupportedEvents()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const textDelta = (delta: string): ResponseStreamEvent => ({
  type: 'response.output_text.delta',
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta,
  logprobs: [],
  sequence_number: 0,
});

const reasoningDelta = (): ResponseStreamEvent => ({
  type: 'response.reasoning_summary_text.delta',
  item_id: 'rs_1',
  output_index: 0,
  summary_index: 0,
  delta: 'thinking',
  sequence_number: 0,
});

const functionArgsDelta = (): ResponseStreamEvent => ({
  type: 'response.function_call_arguments.delta',
  item_id: 'fc_1',
  output_index: 0,
  delta: '{"a":',
  sequence_number: 0,
});

describe('SUPPORTED_EVENT_TYPES', () => {
  it('includes the streamed-text family and excludes reasoning / function-call args', () => {
    expect(SUPPORTED_EVENT_TYPES.has('response.output_text.delta')).toBe(true);
    expect(SUPPORTED_EVENT_TYPES.has('response.output_item.added')).toBe(true);
    expect(SUPPORTED_EVENT_TYPES.has('response.reasoning_summary_text.delta')).toBe(false);
    expect(SUPPORTED_EVENT_TYPES.has('response.function_call_arguments.delta')).toBe(false);
  });
});

describe('filterSupportedEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards supported events and drops unsupported ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const survivors = await runThrough([
      textDelta('Hello'),
      reasoningDelta(),
      textDelta(' world'),
      functionArgsDelta(),
    ]);
    expect(survivors.map((e) => e.type)).toEqual(['response.output_text.delta', 'response.output_text.delta']);
    expect(warn).toHaveBeenCalled();
  });

  it('logs each dropped type only once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runThrough([reasoningDelta(), reasoningDelta(), functionArgsDelta()]);
    // Two distinct dropped types → two warnings, despite three dropped events.
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
