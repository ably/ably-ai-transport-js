import { useState } from 'react';

import { type Entry, type ToolCall, toolCallsOf } from './lib';

/** What `useToolApproval` reads the pending calls from, and how it sends the answers. */
export interface UseToolApprovalOptions {
  /** The last entry on the page; its tool calls are the ones waiting for an answer. */
  last: Entry | undefined;
  /** Whether a turn is in flight, which holds every call back until it ends. */
  held: boolean;
  /** Sends the user's answer to every call in the reply, by tool use id, to the agent, which runs the approved ones. */
  approve: (approvals: Record<string, boolean>) => Promise<void>;
}

/** The tool calls waiting for the user, and the way to answer one. */
export interface ToolApprovalHandle {
  /** The calls in the last reply that have no answer yet. */
  pending: ToolCall[];
  /** Records the user's answer to one call; once every call in the reply has one, sends them all. */
  answer: (call: ToolCall, approved: boolean) => Promise<void>;
}

/**
 * A reply that ends with tool calls waits for the user. Every call gets an
 * answer, approved or refused, and the answers go to the agent together:
 * the agent runs the approved calls and sends Claude every result in one
 * user message, which is how the Messages API takes the results of parallel
 * calls.
 * @param options - The last entry, whether a turn holds the calls back, and how to send the answers.
 * @returns The pending calls and the way to answer one.
 */
export function useToolApproval({ last, held, approve }: UseToolApprovalOptions): ToolApprovalHandle {
  // The user's answers to the pending tool calls, by tool use id, until every
  // call has one and they go to the agent together.
  const [answers, setAnswers] = useState(new Map<string, boolean>());

  const pending = held ? [] : toolCallsOf(last).filter((call) => !answers.has(call.id));

  const answer = async (call: ToolCall, approved: boolean) => {
    const next = new Map(answers).set(call.id, approved);
    setAnswers(next);

    if (!toolCallsOf(last).every((c) => next.has(c.id))) return;

    setAnswers(new Map());
    await approve(Object.fromEntries(next));
  };

  return { pending, answer };
}
