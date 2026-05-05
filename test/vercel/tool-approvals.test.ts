import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { WriteOptions } from '../../src/core/codec/types.js';
import type { MessageNode, Run, StreamResult } from '../../src/core/transport/types.js';
import {
  applyToolApprovalsToHistory,
  extractApprovalDecisionsFromHistory,
  prepareApprovalRun,
  streamResponseWithApprovalRedirect,
  type ToolApprovalDecision,
} from '../../src/vercel/tool-approvals.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const assistantWithPendingApproval = (
  uiMsgId: string,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  approvalId = 'approval-existing',
): AI.UIMessage => ({
  id: uiMsgId,
  role: 'assistant',
  parts: [
    { type: 'step-start' },
    { type: 'text', text: 'I need permission to run this tool.' },
    {
      type: 'dynamic-tool',
      toolCallId,
      toolName,
      state: 'approval-requested',
      input,
      approval: { id: approvalId },
    },
  ],
});

const userMessage = (text: string): AI.UIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
});

// ---------------------------------------------------------------------------
// applyToolApprovalsToHistory
// ---------------------------------------------------------------------------

describe('applyToolApprovalsToHistory', () => {
  it('returns the original array when there are no decisions', () => {
    const messages = [assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' })];
    expect(applyToolApprovalsToHistory(messages, [])).toBe(messages);
  });

  it('transitions a matched tool part to approval-responded when approved', () => {
    const messages = [assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' }, 'ap-1')];
    const decisions: ToolApprovalDecision[] = [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1', reason: 'ok' }];

    const patched = applyToolApprovalsToHistory(messages, decisions);
    const toolPart = patched[0]?.parts.find((p) => p.type === 'dynamic-tool');

    expect(toolPart).toMatchObject({
      type: 'dynamic-tool',
      toolCallId: 't1',
      toolName: 'getForecast',
      state: 'approval-responded',
      input: { location: 'London' },
      approval: { id: 'ap-1', approved: true, reason: 'ok' },
    });
  });

  it('transitions a matched tool part to output-denied when denied', () => {
    const messages = [assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' }, 'ap-1')];
    const decisions: ToolApprovalDecision[] = [{ toolCallId: 't1', approved: false, targetMsgId: 'm-a1' }];

    const patched = applyToolApprovalsToHistory(messages, decisions);
    const toolPart = patched[0]?.parts.find((p) => p.type === 'dynamic-tool');

    expect(toolPart).toMatchObject({
      type: 'dynamic-tool',
      toolCallId: 't1',
      state: 'output-denied',
      approval: { id: 'ap-1', approved: false },
    });
  });

  it('generates an approval id when the part lacks one', () => {
    const msg: AI.UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolCallId: 't1',
          toolName: 'getForecast',
          state: 'input-available',
          input: {},
        },
      ],
    };
    const decisions: ToolApprovalDecision[] = [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1' }];

    const patched = applyToolApprovalsToHistory([msg], decisions);
    const toolPart = patched[0]?.parts.find((p) => p.type === 'dynamic-tool');
    if (toolPart?.type !== 'dynamic-tool') throw new Error('expected dynamic-tool part');

    expect(toolPart).toMatchObject({ state: 'approval-responded', approval: { approved: true } });
    expect(toolPart.approval?.id).toEqual(expect.any(String));
    expect(toolPart.approval?.id).not.toBe('');
  });

  it('passes through messages whose tool parts are not referenced by any decision', () => {
    const untouched = assistantWithPendingApproval('a0', 'other-tool', 'getOther', {});
    const targeted = assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' });
    const messages = [untouched, targeted];

    const patched = applyToolApprovalsToHistory(messages, [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1' }]);

    expect(patched[0]).toBe(untouched);
    expect(patched[1]).not.toBe(targeted);
  });

  it('does not mutate the input array', () => {
    const messages = [assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' })];
    const before = structuredClone(messages);

    applyToolApprovalsToHistory(messages, [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1' }]);

    expect(messages).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// prepareApprovalRun
// ---------------------------------------------------------------------------

describe('prepareApprovalRun', () => {
  const tools = {
    getForecast: {
      description: 'Fetch forecast',
      inputSchema: { jsonSchema: { type: 'object' } },
      needsApproval: true as const,
    },
    other: {
      description: 'Other',
      inputSchema: { jsonSchema: { type: 'object' } },
      needsApproval: true as const,
    },
    // CAST: the tool literals here only need a minimal shape for disableApproval's
    // object spread — real Tool types have additional optional fields we don't exercise.
  } as unknown as Record<string, AI.Tool>;

  it('returns model messages and unchanged tools when no decisions are passed', async () => {
    const msg = userMessage('hi');
    const result = await prepareApprovalRun({ messages: [msg], decisions: undefined, tools });
    expect(result.tools).toBe(tools);
    expect(result.modelMessages).toBeInstanceOf(Array);
  });

  it('returns model messages and unchanged tools when decisions is empty', async () => {
    const result = await prepareApprovalRun({ messages: [userMessage('hi')], decisions: [], tools });
    expect(result.tools).toBe(tools);
  });

  it('strips a trailing user message when decisions are present', async () => {
    const assistant = assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' });
    const trailingUser = userMessage('Approved: London');
    const messages = [userMessage('forecast for london?'), assistant, trailingUser];

    const result = await prepareApprovalRun({
      messages,
      decisions: [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1' }],
      tools,
    });

    expect(result.modelMessages.at(-1)?.role).not.toBe('user');
  });

  it('leaves the trailing assistant/tool message alone when there is no trailing user message', async () => {
    const assistant = assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' });
    const messages = [userMessage('forecast for london?'), assistant];

    const result = await prepareApprovalRun({
      messages,
      decisions: [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1' }],
      tools,
    });

    expect(result.modelMessages.length).toBeGreaterThan(0);
    expect(result.modelMessages.at(-1)?.role).not.toBe('user');
  });

  it('disables needsApproval on approved tools', async () => {
    const assistant = assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' });
    const result = await prepareApprovalRun({
      messages: [assistant],
      decisions: [{ toolCallId: 't1', approved: true, targetMsgId: 'm-a1' }],
      tools,
    });

    expect((result.tools.getForecast as { needsApproval: boolean }).needsApproval).toBe(false);
    expect((result.tools.other as { needsApproval: boolean }).needsApproval).toBe(true);
  });

  it('leaves needsApproval unchanged on denied tools', async () => {
    const assistant = assistantWithPendingApproval('a1', 't1', 'getForecast', { location: 'London' });
    const result = await prepareApprovalRun({
      messages: [assistant],
      decisions: [{ toolCallId: 't1', approved: false, targetMsgId: 'm-a1' }],
      tools,
    });

    expect((result.tools.getForecast as { needsApproval: boolean }).needsApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// streamResponseWithApprovalRedirect
// ---------------------------------------------------------------------------

interface MockRun {
  run: Run<AI.UIMessageChunk, AI.UIMessage>;
  pipeMock: ReturnType<typeof vi.fn>;
}

const createMockRun = (): MockRun => {
  const pipeMock = vi.fn(
    // eslint-disable-next-line @typescript-eslint/require-await -- mock; stream is not read
    async (): Promise<StreamResult> => ({ reason: 'complete' }),
  );

  const run = {
    runId: 'run-1',
    abortSignal: new AbortController().signal,
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
    start: vi.fn(async () => {}),
    addMessages: vi.fn(),
    pipe: pipeMock,
    addEvents: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
    end: vi.fn(async () => {}),
  } as unknown as Run<AI.UIMessageChunk, AI.UIMessage>;

  return { run, pipeMock };
};

const streamOf = (...chunks: AI.UIMessageChunk[]): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/**
 * Pull the `resolveWriteOptions` hook out of the last `pipe` call.
 * @param mock - The mock run whose last `pipe` call to inspect.
 * @returns The resolver function passed by the helper, or undefined.
 */
const lastResolver = (mock: MockRun): ((event: AI.UIMessageChunk) => WriteOptions | undefined) | undefined => {
  const call = mock.pipeMock.mock.calls.at(-1);
  const opts = call?.[1] as
    | { resolveWriteOptions?: (event: AI.UIMessageChunk) => WriteOptions | undefined }
    | undefined;
  return opts?.resolveWriteOptions;
};

describe('streamResponseWithApprovalRedirect', () => {
  it('delegates straight to run.pipe with no resolver when no approvals are approved', async () => {
    const mock = createMockRun();

    await streamResponseWithApprovalRedirect(mock.run, streamOf(), {
      parent: 'p1',
      forkOf: 'f1',
      decisions: [{ toolCallId: 't1', approved: false, targetMsgId: 'm-a1' }],
    });

    expect(mock.pipeMock).toHaveBeenCalledWith(expect.any(ReadableStream), { parent: 'p1', forkOf: 'f1' });
    expect(lastResolver(mock)).toBeUndefined();
  });

  it('delegates straight to run.pipe with no resolver when decisions is absent or empty', async () => {
    const mock = createMockRun();

    await streamResponseWithApprovalRedirect(mock.run, streamOf(), { parent: 'p1', decisions: undefined });
    expect(lastResolver(mock)).toBeUndefined();

    await streamResponseWithApprovalRedirect(mock.run, streamOf(), { parent: 'p1', decisions: [] });
    expect(lastResolver(mock)).toBeUndefined();
  });

  it('returns WriteOptions for approved tool-output-available chunks', async () => {
    const mock = createMockRun();

    await streamResponseWithApprovalRedirect(mock.run, streamOf(), {
      parent: 'p1',
      decisions: [{ toolCallId: 't1', approved: true, targetMsgId: 'm-original' }],
    });

    const resolver = lastResolver(mock);
    expect(resolver).toBeDefined();
    if (!resolver) return;

    const chunk: AI.UIMessageChunk = {
      type: 'tool-output-available',
      toolCallId: 't1',
      output: { forecast: 'sunny' },
      dynamic: true,
      providerExecuted: false,
      preliminary: false,
    };

    expect(resolver(chunk)).toEqual({
      messageId: 'm-original',
      extras: { headers: { 'x-ably-amend': 'm-original' } },
    });
  });

  it('returns WriteOptions for approved tool-output-error chunks', async () => {
    const mock = createMockRun();

    await streamResponseWithApprovalRedirect(mock.run, streamOf(), {
      parent: 'p1',
      decisions: [{ toolCallId: 't1', approved: true, targetMsgId: 'm-original' }],
    });

    const resolver = lastResolver(mock);
    if (!resolver) throw new Error('expected resolver');

    const chunk: AI.UIMessageChunk = {
      type: 'tool-output-error',
      toolCallId: 't1',
      errorText: 'boom',
      dynamic: true,
      providerExecuted: false,
    };

    expect(resolver(chunk)).toEqual({
      messageId: 'm-original',
      extras: { headers: { 'x-ably-amend': 'm-original' } },
    });
  });

  it('returns undefined for unapproved tool outputs, denied toolCallIds, and non-tool-output chunks', async () => {
    const mock = createMockRun();

    await streamResponseWithApprovalRedirect(mock.run, streamOf(), {
      parent: 'p1',
      decisions: [
        { toolCallId: 't1', approved: true, targetMsgId: 'm-1' },
        { toolCallId: 't2', approved: false, targetMsgId: 'm-2' },
      ],
    });

    const resolver = lastResolver(mock);
    if (!resolver) throw new Error('expected resolver');

    // Non-matching toolCallId
    expect(
      resolver({
        type: 'tool-output-available',
        toolCallId: 'other',
        output: {},
        dynamic: true,
        providerExecuted: false,
        preliminary: false,
      }),
    ).toBeUndefined();

    // Denied toolCallId (not in the targets map)
    expect(
      resolver({
        type: 'tool-output-available',
        toolCallId: 't2',
        output: {},
        dynamic: true,
        providerExecuted: false,
        preliminary: false,
      }),
    ).toBeUndefined();

    // Non-tool-output chunk type
    expect(resolver({ type: 'text-start', id: 'tx-1' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractApprovalDecisionsFromHistory
// ---------------------------------------------------------------------------

const assistantNode = (msgId: string, parts: AI.UIMessage['parts']): MessageNode<AI.UIMessage> => ({
  kind: 'message',
  msgId,
  parentId: undefined,
  forkOf: undefined,
  message: { id: `ui-${msgId}`, role: 'assistant', parts },
  headers: {},
  serial: undefined,
});

describe('extractApprovalDecisionsFromHistory', () => {
  it('returns an approved decision for each approval-responded part', () => {
    const history = [
      assistantNode('m-1', [
        {
          type: 'dynamic-tool',
          toolCallId: 't1',
          toolName: 'getForecast',
          state: 'approval-responded',
          input: {},
          approval: { id: 'ap-1', approved: true },
        },
      ]),
    ];

    expect(extractApprovalDecisionsFromHistory(history)).toEqual([
      { toolCallId: 't1', approved: true, targetMsgId: 'm-1' },
    ]);
  });

  it('preserves the approval reason when present', () => {
    const history = [
      assistantNode('m-1', [
        {
          type: 'dynamic-tool',
          toolCallId: 't1',
          toolName: 'getForecast',
          state: 'approval-responded',
          input: {},
          approval: { id: 'ap-1', approved: true, reason: 'looks safe' },
        },
      ]),
    ];

    expect(extractApprovalDecisionsFromHistory(history)).toEqual([
      { toolCallId: 't1', approved: true, targetMsgId: 'm-1', reason: 'looks safe' },
    ]);
  });

  it('returns a denied decision for each output-denied part', () => {
    const history = [
      assistantNode('m-1', [
        {
          type: 'dynamic-tool',
          toolCallId: 't1',
          toolName: 'getForecast',
          state: 'output-denied',
          input: {},
          approval: { id: 'ap-1', approved: false },
        },
      ]),
    ];

    expect(extractApprovalDecisionsFromHistory(history)).toEqual([
      { toolCallId: 't1', approved: false, targetMsgId: 'm-1' },
    ]);
  });

  it('ignores tool parts in other states', () => {
    const history = [
      assistantNode('m-1', [
        {
          type: 'dynamic-tool',
          toolCallId: 't-req',
          toolName: 'getForecast',
          state: 'approval-requested',
          input: {},
          approval: { id: 'ap-r' },
        },
        {
          type: 'dynamic-tool',
          toolCallId: 't-avail',
          toolName: 'getWeather',
          state: 'output-available',
          input: {},
          output: { temp: 70 },
        },
        { type: 'text', text: 'hi' },
      ]),
    ];

    expect(extractApprovalDecisionsFromHistory(history)).toEqual([]);
  });

  it('returns decisions across multiple messages in walk order', () => {
    const history = [
      assistantNode('m-1', [
        {
          type: 'dynamic-tool',
          toolCallId: 't1',
          toolName: 'getForecast',
          state: 'approval-responded',
          input: {},
          approval: { id: 'ap-1', approved: true },
        },
      ]),
      assistantNode('m-2', [
        {
          type: 'dynamic-tool',
          toolCallId: 't2',
          toolName: 'getForecast',
          state: 'output-denied',
          input: {},
          approval: { id: 'ap-2', approved: false },
        },
      ]),
    ];

    expect(extractApprovalDecisionsFromHistory(history)).toEqual([
      { toolCallId: 't1', approved: true, targetMsgId: 'm-1' },
      { toolCallId: 't2', approved: false, targetMsgId: 'm-2' },
    ]);
  });
});
