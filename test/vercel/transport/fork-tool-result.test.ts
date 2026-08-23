/**
 * Unit tests for `createToolResultFork` — the raw-path helper that builds the
 * enriched tool-result input + send options a client uses to fork a suspended
 * tool call into its own reply run. It publishes RUN-LESS (no run-id — the agent
 * mints the fork's run-id), minting a fresh codec-message-id per run message,
 * seeding the WHOLE run, targeting the message carrying the resolved tool call,
 * and always setting the required parent plus `role: 'assistant'`.
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { CodecMessage } from '../../../src/core/transport/session-codec.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelSessionInput } from '../../../src/vercel/codec/session-events.js';
import { createToolResultFork } from '../../../src/vercel/transport/fork-tool-result.js';
import { toBeErrorInfo } from '../../helper/expectations.js';

expect.extend({ toBeErrorInfo });

const toolCallAssistant = (id: string, toolCallId: string): AI.UIMessage => {
  const part: AI.DynamicToolUIPart = {
    type: 'dynamic-tool',
    toolName: 'getLocation',
    toolCallId,
    state: 'input-available',
    input: {},
  };
  return { id, role: 'assistant', parts: [part] };
};

const resolvedAssistant = (id: string, toolCallId: string, output: unknown): AI.UIMessage => {
  const part: AI.DynamicToolUIPart = {
    type: 'dynamic-tool',
    toolName: 'getLocation',
    toolCallId,
    state: 'output-available',
    input: {},
    output,
  };
  return { id, role: 'assistant', parts: [part] };
};

// The suspended run's projection (as `UIMessageCodec.getMessages` would yield
// it): each message paired with its own codec-message-id (`cm-<id>` here).
const runMessagesOf = (...messages: AI.UIMessage[]): CodecMessage<AI.UIMessage>[] =>
  messages.map((message) => ({ codecMessageId: `cm-${message.id}`, message }));

describe('createToolResultFork', () => {
  it('publishes run-less (no run-id) with a fresh target id, and seeds the run for a success result', () => {
    const runMessages = runMessagesOf(toolCallAssistant('a1', 'tc1'));
    const { input, sendOptions } = createToolResultFork({
      runMessages,
      parentCodecMessageId: 'u1',
      toolCallId: 'tc1',
      result: { output: { city: 'Hong Kong' } },
      supersedesRunId: 'run-trunk',
    });

    expect(input.kind).toBe('tool-result');
    const toolResult = input.kind === 'tool-result' ? input : undefined;
    expect(toolResult?.payload.output).toEqual({ city: 'Hong Kong' });
    // The seed carries the run's message, under a FRESH codec-message-id (never
    // the run's own codec-message-id).
    expect(toolResult?.payload.forkSeed?.messages).toHaveLength(1);
    const seedMsg = toolResult?.payload.forkSeed?.messages[0];
    expect(seedMsg?.message.id).toBe('a1');
    expect(seedMsg?.codecMessageId).not.toBe('cm-a1');
    // The result targets the fresh id of the seed message carrying tc1.
    expect(input.codecMessageId).toBe(seedMsg?.codecMessageId);
    // Run-less: NO run-id (the agent mints the fork's run-id). The required
    // parent and role:'assistant' (marking the reconstructed assistant turn) are
    // set so the tree classifies the run-less input as a reply run.
    expect(sendOptions.runId).toBeUndefined();
    expect(sendOptions.parent).toBe('u1');
    expect(sendOptions.role).toBe('assistant');
    // Supersedes the suspended run it resolves, so the tree hides that dead
    // trunk — a single response renders linearly (no spurious sibling).
    expect(sendOptions.supersedes).toBe('run-trunk');
  });

  it('builds a run-less tool-result-error variant carrying the seed, parent, and role', () => {
    const runMessages = runMessagesOf(toolCallAssistant('a1', 'tc1'));
    const { input, sendOptions } = createToolResultFork({
      runMessages,
      parentCodecMessageId: 'u1',
      toolCallId: 'tc1',
      result: { errorMessage: 'geolocation denied' },
      supersedesRunId: 'run-trunk',
    });

    expect(input.kind).toBe('tool-result-error');
    const err = input.kind === 'tool-result-error' ? input : undefined;
    expect(err?.payload.message).toBe('geolocation denied');
    expect(err?.payload.forkSeed?.messages).toHaveLength(1);
    expect(input.codecMessageId).toBe(err?.payload.forkSeed?.messages[0]?.codecMessageId);
    expect(sendOptions.parent).toBe('u1');
    expect(sendOptions.role).toBe('assistant');
    expect(sendOptions.runId).toBeUndefined();
    expect(sendOptions.supersedes).toBe('run-trunk');
  });

  it('seeds the FULL run (all messages, fresh ids) and targets the message carrying the tool call', () => {
    const runMessages = runMessagesOf(
      resolvedAssistant('a-prior', 'tc-prior', { city: 'Paris' }),
      toolCallAssistant('a-current', 'tc-current'),
    );
    const { input } = createToolResultFork({
      runMessages,
      parentCodecMessageId: 'u1',
      toolCallId: 'tc-current',
      result: { output: { city: 'Berlin' } },
      supersedesRunId: 'run-trunk',
    });

    const toolResult = input.kind === 'tool-result' ? input : undefined;
    const seed = toolResult?.payload.forkSeed;
    expect(seed?.messages).toHaveLength(2);
    // Every seed id is fresh — none equal to the source codec-message-ids.
    const seedIds = seed?.messages.map((m) => m.codecMessageId) ?? [];
    expect(seedIds).not.toContain('cm-a-prior');
    expect(seedIds).not.toContain('cm-a-current');
    // The target is the fresh id of the message carrying tc-current.
    const currentSeed = seed?.messages.find((m) => m.message.id === 'a-current');
    expect(input.codecMessageId).toBe(currentSeed?.codecMessageId);
    // The prior resolved call is carried too — full context preserved.
    const priorSeed = seed?.messages.find((m) => m.message.id === 'a-prior');
    expect(priorSeed?.message.parts).toContainEqual(
      expect.objectContaining({ toolCallId: 'tc-prior', state: 'output-available' }),
    );
  });

  it('mints independent target ids on each call (two tabs never collide)', () => {
    const runMessages = runMessagesOf(toolCallAssistant('a1', 'tc1'));
    const forkA = createToolResultFork({
      runMessages,
      parentCodecMessageId: 'u1',
      toolCallId: 'tc1',
      result: { output: 1 },
      supersedesRunId: 'run-trunk',
    });
    const forkB = createToolResultFork({
      runMessages,
      parentCodecMessageId: 'u1',
      toolCallId: 'tc1',
      result: { output: 2 },
      supersedesRunId: 'run-trunk',
    });

    // Both are run-less (the agent mints each fork's run-id). Independence lives
    // on the client-owned target codec-message-id — two tabs reconstruct two
    // distinct optimistic reply runs the agent then reconciles to distinct ids.
    expect(forkA.sendOptions.runId).toBeUndefined();
    expect(forkB.sendOptions.runId).toBeUndefined();
    expect((forkA.input as Extract<VercelSessionInput, { kind: 'tool-result' }>).codecMessageId).not.toBe(
      (forkB.input as Extract<VercelSessionInput, { kind: 'tool-result' }>).codecMessageId,
    );
  });

  it('throws an ErrorInfo when no run message carries the tool call', () => {
    const runMessages = runMessagesOf(toolCallAssistant('a1', 'tc1'));
    let caught: unknown;
    try {
      createToolResultFork({
        runMessages,
        parentCodecMessageId: 'u1',
        toolCallId: 'tc-missing',
        result: { output: {} },
        supersedesRunId: 'run-trunk',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeErrorInfo({ code: ErrorCode.InvalidArgument });
  });
});
