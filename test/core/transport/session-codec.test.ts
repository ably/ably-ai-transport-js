import { describe, expect, it } from 'vitest';

import type {
  CodecMessage,
  Regenerate,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
} from '../../../src/core/transport/session-codec.js';
import { defineSessionCodec, wellKnownInputs } from '../../../src/core/transport/session-codec.js';

// A representative codec input union with simple domain payloads. The helper is
// codec-agnostic, so the test stands in its own minimal domain.
interface TestResultPayload {
  toolCallId: string;
  output: unknown;
}
interface TestErrorPayload {
  toolCallId: string;
  message: string;
}
interface TestApprovalPayload {
  toolCallId: string;
  approved: boolean;
}
interface TestMessage {
  id: string;
  text: string;
}
type TestInput =
  | UserMessage<TestMessage>
  | Regenerate
  | ToolResult<TestResultPayload>
  | ToolResultError<TestErrorPayload>
  | ToolApprovalResponse<TestApprovalPayload>;

describe('wellKnownInputs', () => {
  const inputs = wellKnownInputs<TestInput>();

  it('createUserMessage wraps a domain message', () => {
    const message: TestMessage = { id: 'm1', text: 'hi' };
    const event = inputs.createUserMessage(message);
    expect(event).toEqual({ kind: 'user-message', message });
  });

  it('createRegenerate carries target and parent', () => {
    const event = inputs.createRegenerate('assistant-1', 'user-1');
    expect(event).toEqual({ kind: 'regenerate', target: 'assistant-1', parent: 'user-1' });
  });

  it('createToolResult carries the codecMessageId and payload', () => {
    const payload: TestResultPayload = { toolCallId: 't1', output: { ok: true } };
    const event = inputs.createToolResult('assistant-1', payload);
    expect(event).toEqual({ kind: 'tool-result', codecMessageId: 'assistant-1', payload });
  });

  it('createToolResultError carries the codecMessageId and payload', () => {
    const payload: TestErrorPayload = { toolCallId: 't1', message: 'boom' };
    const event = inputs.createToolResultError('assistant-1', payload);
    expect(event).toEqual({ kind: 'tool-result-error', codecMessageId: 'assistant-1', payload });
  });

  it('createToolApprovalResponse carries the codecMessageId and payload', () => {
    const payload: TestApprovalPayload = { toolCallId: 't1', approved: false };
    const event = inputs.createToolApprovalResponse('assistant-1', payload);
    expect(event).toEqual({ kind: 'tool-approval-response', codecMessageId: 'assistant-1', payload });
  });

  it('factories are payload-typed from TInput (type check)', () => {
    // Each result is assignable to its specific variant type — fails typecheck
    // if the helper's payload extraction or return typing regresses.
    const user: UserMessage<TestMessage> = inputs.createUserMessage({ id: 'm1', text: 'hi' });
    const regen: Regenerate = inputs.createRegenerate('a', 'p');
    const result: ToolResult<TestResultPayload> = inputs.createToolResult('m', { toolCallId: 't', output: 1 });
    const error: ToolResultError<TestErrorPayload> = inputs.createToolResultError('m', {
      toolCallId: 't',
      message: 'e',
    });
    const approval: ToolApprovalResponse<TestApprovalPayload> = inputs.createToolApprovalResponse('m', {
      toolCallId: 't',
      approved: true,
    });

    expect(user.message.id).toBe('m1');
    expect(regen.target).toBe('a');
    expect(result.payload.toolCallId).toBe('t');
    expect(error.payload.message).toBe('e');
    expect(approval.payload.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defineSessionCodec — reducer and factory wiring
// ---------------------------------------------------------------------------

interface WiringOutput {
  type: 'quirky';
}
interface WiringInput {
  kind: 'noop';
  codecMessageId: string;
  payload: Record<string, never>;
}
interface WiringProjection {
  folded: (WiringInput | WiringOutput)[];
}

const wiringCodec = defineSessionCodec<WiringInput, WiringOutput>()({
  reducer: {
    init: (): WiringProjection => ({ folded: [] }),
    fold: (state, event): WiringProjection => {
      state.folded.push(event.event);
      return state;
    },
    getMessages: (projection): CodecMessage<WiringInput | WiringOutput>[] =>
      projection.folded.map((message, i) => ({ codecMessageId: `cm-${String(i)}`, message })),
  },
  output: ({ event }) => [event('quirky')],
  input: ({ event }) => [event('noop')],
  factories: (base) => ({
    createUserMessage: base.createUserMessage,
    createRegenerate: base.createRegenerate,
  }),
});

describe('defineSessionCodec — reducer wiring', () => {
  it('threads init / fold / getMessages from the supplied reducer parts', () => {
    let state = wiringCodec.init();
    expect(wiringCodec.getMessages(state)).toEqual([]);

    const output: WiringOutput = { type: 'quirky' };
    const input: WiringInput = { kind: 'noop', codecMessageId: 'cm-x', payload: {} };
    state = wiringCodec.fold(state, { direction: 'output', event: output }, { serial: 's1', messageId: 'm1' });
    state = wiringCodec.fold(state, { direction: 'input', event: input }, { serial: 's2', messageId: 'm2' });

    expect(wiringCodec.getMessages(state)).toEqual([
      { codecMessageId: 'cm-0', message: output },
      { codecMessageId: 'cm-1', message: input },
    ]);
  });

  it('assembles a working wire tier alongside the reducer', () => {
    expect(wiringCodec.createDecoder()).toBeDefined();
  });
});

describe('defineSessionCodec — factory spread', () => {
  it('exposes the mandatory factories the builder returned', () => {
    expect(typeof wiringCodec.createUserMessage).toBe('function');
    expect(wiringCodec.createRegenerate('assistant-1', 'user-1')).toEqual({
      kind: 'regenerate',
      target: 'assistant-1',
      parent: 'user-1',
    });
  });

  it('does not spread the tool factories the builder omitted', () => {
    expect(wiringCodec.createToolResult).toBeUndefined();
    expect(wiringCodec.createToolResultError).toBeUndefined();
    expect(wiringCodec.createToolApprovalResponse).toBeUndefined();
  });
});
