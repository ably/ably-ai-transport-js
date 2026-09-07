import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import { approvedPendingToolCalls, pendingToolCalls, stripToolExecutes } from '../../src/vercel/tool-registry.js';

// CAST: minimal UIMessage shaped for the helpers under test.
const msg = (m: object): AI.UIMessage => m as AI.UIMessage;

describe('stripToolExecutes', () => {
  it('removes execute from every tool while keeping other fields', () => {
    const tools = {
      getWeather: {
        description: 'Get weather',
        inputSchema: { type: 'object' },
        execute: async () => {
          await Promise.resolve();
          return { temp: 72 };
        },
      },
      getLocation: {
        description: 'Get location',
        inputSchema: { type: 'object' },
      },
    } as unknown as Record<string, AI.Tool>;

    const stripped = stripToolExecutes(tools);

    expect((stripped.getWeather as { execute?: unknown }).execute).toBeUndefined();
    expect((stripped.getLocation as { execute?: unknown }).execute).toBeUndefined();
    // Non-execute fields are preserved.
    expect((stripped.getWeather as { description?: string }).description).toBe('Get weather');
    expect((stripped.getLocation as { description?: string }).description).toBe('Get location');
  });

  it('preserves needsApproval so approval-gated tools still emit tool-approval-request', () => {
    const tools = {
      getWeatherForecast: {
        description: 'forecast',
        execute: async () => {
          await Promise.resolve();
          return { forecast: [] };
        },
        needsApproval: () => true,
      },
    } as unknown as Record<string, AI.Tool>;

    const stripped = stripToolExecutes(tools);

    expect((stripped.getWeatherForecast as { execute?: unknown }).execute).toBeUndefined();
    expect((stripped.getWeatherForecast as { needsApproval?: unknown }).needsApproval).toBe(
      (tools.getWeatherForecast as { needsApproval?: unknown }).needsApproval,
    );
  });

  it('returns a fresh registry — the original is not mutated', () => {
    const original = {
      getWeather: {
        description: 'w',
        execute: async () => {
          await Promise.resolve();
          return { temp: 60 };
        },
      },
    } as unknown as Record<string, AI.Tool>;

    const stripped = stripToolExecutes(original);

    // Original untouched.
    expect((original.getWeather as { execute?: unknown }).execute).toBeTypeOf('function');
    // Stripped is a separate object.
    expect(stripped).not.toBe(original);
    expect(stripped.getWeather).not.toBe(original.getWeather);
  });

  it('returns an empty registry when given one', () => {
    expect(stripToolExecutes({})).toEqual({});
  });
});

describe('pendingToolCalls', () => {
  it('returns pending tool calls from the last assistant message (dynamic-tool shape)', () => {
    const messages = [
      msg({ role: 'user', parts: [{ type: 'text', text: 'weather?' }] }),
      msg({
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'dynamic-tool',
            toolCallId: 'call-1',
            toolName: 'getLocation',
            state: 'input-available',
            input: { highAccuracy: false },
          },
        ],
      }),
    ];

    const pending = pendingToolCalls(messages);

    expect(pending).toEqual([{ toolCallId: 'call-1', toolName: 'getLocation', input: { highAccuracy: false } }]);
  });

  it('returns pending tool calls from the AI SDK tool-${name} shape', () => {
    const messages = [
      msg({
        role: 'assistant',
        parts: [
          {
            type: 'tool-getWeather',
            toolCallId: 'call-2',
            state: 'input-available',
            input: { location: 'Paris' },
          },
        ],
      }),
    ];

    const pending = pendingToolCalls(messages);

    expect(pending).toEqual([{ toolCallId: 'call-2', toolName: 'getWeather', input: { location: 'Paris' } }]);
  });

  it('skips tool parts whose state is not input-available', () => {
    const messages = [
      msg({
        role: 'assistant',
        parts: [
          { type: 'dynamic-tool', toolCallId: 'a', toolName: 'x', state: 'input-streaming' },
          { type: 'dynamic-tool', toolCallId: 'b', toolName: 'y', state: 'output-available', output: 42 },
          { type: 'dynamic-tool', toolCallId: 'c', toolName: 'z', state: 'input-available', input: {} },
          {
            type: 'dynamic-tool',
            toolCallId: 'd',
            toolName: 'w',
            state: 'approval-requested',
            input: {},
            approval: { id: 'ap-d' },
          },
          {
            type: 'dynamic-tool',
            toolCallId: 'e',
            toolName: 'v',
            state: 'approval-responded',
            input: {},
            approval: { id: 'ap-e', approved: true },
          },
          {
            type: 'dynamic-tool',
            toolCallId: 'f',
            toolName: 'u',
            state: 'output-denied',
            input: {},
            approval: { id: 'ap-f', approved: false },
          },
        ],
      }),
    ];

    // Only the input-available one is pending — approval-responded is the
    // domain of approvedPendingToolCalls, and the others are either
    // in-flight, resolved, or awaiting the user.
    expect(pendingToolCalls(messages).map((p) => p.toolCallId)).toEqual(['c']);
  });

  it('returns [] when there is no assistant message', () => {
    const messages = [msg({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })];
    expect(pendingToolCalls(messages)).toEqual([]);
  });

  it('returns [] when the messages array is empty', () => {
    expect(pendingToolCalls([])).toEqual([]);
  });

  it('returns [] when the last assistant has no tool parts', () => {
    const messages = [msg({ role: 'assistant', parts: [{ type: 'text', text: 'done' }] })];
    expect(pendingToolCalls(messages)).toEqual([]);
  });

  it('inspects the last assistant — a fully-answered trailing assistant means nothing pending', () => {
    const messages = [
      msg({
        role: 'assistant',
        parts: [{ type: 'dynamic-tool', toolCallId: 'earlier', toolName: 'x', state: 'input-available', input: {} }],
      }),
      msg({ role: 'user', parts: [{ type: 'text', text: 'follow-up' }] }),
      msg({ role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }),
    ];

    // The last assistant is text-only — no pending tool calls, even though an
    // earlier assistant had one (it was already resolved by the later turn).
    expect(pendingToolCalls(messages)).toEqual([]);
  });

  it('finds the pending call on the last assistant when a steer message trails it', () => {
    // A client steering message merges into the run while a tool-call pass is
    // streaming; in raw run.messages order it sorts after the assistant
    // tool-call message. The pending server tool still owes an output, so it
    // must be found and dispatched before the steer can be processed.
    const messages = [
      msg({ role: 'user', parts: [{ type: 'text', text: 'weather in Tokyo?' }] }),
      msg({
        role: 'assistant',
        parts: [
          {
            type: 'tool-getWeather',
            toolCallId: 'call-weather',
            state: 'input-available',
            input: { location: 'Tokyo' },
          },
        ],
      }),
      msg({ role: 'user', parts: [{ type: 'text', text: 'actually London' }] }),
    ];

    expect(pendingToolCalls(messages)).toEqual([
      { toolCallId: 'call-weather', toolName: 'getWeather', input: { location: 'Tokyo' } },
    ]);
  });
});

describe('approvedPendingToolCalls', () => {
  it('returns approval-responded tool calls — the user approved and the framework owes an output', () => {
    const messages = [
      msg({ role: 'user', parts: [{ type: 'text', text: 'forecast?' }] }),
      msg({
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'call-forecast',
            toolName: 'getWeatherForecast',
            state: 'approval-responded',
            input: { location: 'London, UK' },
            approval: { id: 'ap-1', approved: true },
          },
        ],
      }),
    ];

    expect(approvedPendingToolCalls(messages)).toEqual([
      { toolCallId: 'call-forecast', toolName: 'getWeatherForecast', input: { location: 'London, UK' } },
    ]);
  });

  it('does NOT return input-available parts — those are the domain of pendingToolCalls', () => {
    const messages = [
      msg({
        role: 'assistant',
        parts: [
          { type: 'dynamic-tool', toolCallId: 'fresh', toolName: 'x', state: 'input-available', input: {} },
          {
            type: 'dynamic-tool',
            toolCallId: 'approved',
            toolName: 'y',
            state: 'approval-responded',
            input: {},
            approval: { id: 'ap-1', approved: true },
          },
        ],
      }),
    ];

    expect(approvedPendingToolCalls(messages).map((p) => p.toolCallId)).toEqual(['approved']);
  });

  it('returns [] when there is no assistant message', () => {
    const messages = [msg({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })];
    expect(approvedPendingToolCalls(messages)).toEqual([]);
  });

  it('returns [] when the messages array is empty', () => {
    expect(approvedPendingToolCalls([])).toEqual([]);
  });

  it('finds the approved call on the last assistant when a steer message trails it', () => {
    // Approval-resume equivalent of the steering race: the just-approved tool
    // still owes an output, and a steer that landed during the approval must
    // not hide it from the pre-check that dispatches it.
    const messages = [
      msg({ role: 'user', parts: [{ type: 'text', text: 'forecast?' }] }),
      msg({
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'call-forecast',
            toolName: 'getWeatherForecast',
            state: 'approval-responded',
            input: { location: 'London, UK' },
            approval: { id: 'ap-1', approved: true },
          },
        ],
      }),
      msg({ role: 'user', parts: [{ type: 'text', text: 'actually make it Paris' }] }),
    ];

    expect(approvedPendingToolCalls(messages)).toEqual([
      { toolCallId: 'call-forecast', toolName: 'getWeatherForecast', input: { location: 'London, UK' } },
    ]);
  });

  it('excludes denied approval-responded parts — approved: false is NOT dispatched to the tool-execute path', () => {
    const messages = [
      msg({
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'denied',
            toolName: 'x',
            state: 'approval-responded',
            input: { location: 'London, UK' },
            approval: { id: 'ap-1', approved: false },
          },
          {
            type: 'dynamic-tool',
            toolCallId: 'approved',
            toolName: 'y',
            state: 'approval-responded',
            input: {},
            approval: { id: 'ap-2', approved: true },
          },
        ],
      }),
    ];

    expect(approvedPendingToolCalls(messages).map((p) => p.toolCallId)).toEqual(['approved']);
  });
});
