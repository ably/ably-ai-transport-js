/**
 * Helpers for driving a self-controlled agentic loop on top of the Vercel AI
 * SDK — i.e. one that owns its own step boundaries rather than letting
 * `streamText` run its internal multi-step loop.
 *
 * `stripToolExecutes` produces a tools registry with the server-side
 * `execute` removed so `streamText` emits tool-call parts and stops (rather
 * than executing tools inline). `pendingToolCalls` classifies the parts on
 * the last assistant message so the framework driver can decide what to do
 * next — dispatch a tool activity, suspend for a client tool, or request
 * approval.
 *
 * Neither helper depends on this SDK's transport — they only shape the
 * Vercel types the caller passes in and out.
 */

import type * as AI from 'ai';
import { getToolName } from 'ai';

import { isToolPart } from './tool-part.js';

/**
 * Return a copy of the tools registry with every `execute` removed. Use this
 * to feed `streamText` when you want the AI SDK to stop after emitting
 * tool-call parts rather than running server-side tools inline — the caller
 * (a Temporal activity, an Inngest step, a background worker) then owns the
 * tool-execute-and-continue loop and can put each tool call under its own
 * durable step.
 *
 * `needsApproval` (if present) is preserved: approval-gated tools still emit
 * `tool-approval-request` parts on the first pass. Every other tool field is
 * preserved.
 *
 * The return type is the same registry shape as the input, so callers can
 * assign it back to their tools variable without narrowing.
 * @param tools - The tools registry to strip.
 * @returns A new registry with `execute` removed from every tool.
 */
export const stripToolExecutes = <T extends Record<string, AI.Tool>>(tools: T): T => {
  const stripped: Record<string, AI.Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    // Build the copy by filtering entries rather than destructure-and-rest —
    // the latter needs a rename discard for `execute` that reads as noise.
    // CAST: narrow back to the caller's declared registry shape.
    stripped[name] = Object.fromEntries(Object.entries(tool).filter(([k]) => k !== 'execute')) as AI.Tool;
  }
  return stripped as T;
};

/**
 * One pending tool call the framework driver still owes an output for.
 * Extracted from the last assistant message's parts.
 */
export interface PendingToolCall {
  /** The tool call's id — stable per call, opaque to us. */
  toolCallId: string;
  /** The tool's name (normalised across `dynamic-tool` and `tool-${name}` shapes). */
  toolName: string;
  /** The tool's parsed input, as the model produced it. */
  input: unknown;
}

/**
 * Inspect the last assistant message and return the tool calls the framework
 * driver still owes an output for — parts in `input-available` state, i.e. a
 * fresh call the model just emitted whose input is complete but whose output
 * has not been produced yet. Handles both the codec-normalised `dynamic-tool`
 * shape and the AI SDK's statically-typed `tool-${name}` shape (via
 * {@link isToolPart} and `getToolName`).
 *
 * Does NOT include `approval-responded` parts — those are the domain of
 * {@link approvedPendingToolCalls} and are checked separately at a different
 * point in the driver's loop. Returns an empty array when there is no assistant
 * message, or it has no pending tool parts. Does NOT classify by
 * resolution mechanism (server / client / approval) — that policy belongs to
 * the caller who owns the tools registry and can inspect `execute` /
 * `needsApproval` per call.
 *
 * Typical use — after `streamText` returns, decide what to do next:
 * ```ts
 * const pending = pendingToolCalls(run.messages);
 * for (const call of pending) {
 *   if (tools[call.toolName]?.execute) {
 *     // dispatch a server tool activity
 *   } else {
 *     // suspend for the client (or approval)
 *   }
 * }
 * ```
 * @param messages - The run's `messages` (assistant-terminated turn history).
 * @returns The pending tool calls on the last assistant message, or `[]`.
 */
export const pendingToolCalls = (messages: readonly AI.UIMessage[]): PendingToolCall[] =>
  _toolCallsInState(messages, 'input-available');

/**
 * Inspect the last assistant message and return tool calls the user has just
 * approved but that have not yet been executed — parts in `approval-responded`
 * state whose `approval.approved` is `true`. Parts where the user denied the
 * request (`approved: false`) are excluded; the AI SDK carries the same
 * `approval-responded` state for both outcomes.
 *
 * The typical caller is the workflow driving a follow-up invocation that was
 * triggered by a `tool-approval-response`: before calling `streamText` again,
 * it dispatches these calls to the server-tool path so the LLM's next call
 * carries a matching `tool_result` for each open `tool_use`. Distinct from
 * {@link pendingToolCalls}, which is for fresh model-emitted calls: mixing
 * the two into one check makes the post-`streamText` classification race
 * with the follow-up workflow that a `tool-approval-response` also spawns.
 * @param messages - The run's `messages` (assistant-terminated turn history).
 * @returns The just-approved, not-yet-executed tool calls on the last
 *   assistant message, or `[]`.
 */
export const approvedPendingToolCalls = (messages: readonly AI.UIMessage[]): PendingToolCall[] =>
  _toolCallsInState(messages, 'approval-responded');

const _toolCallsInState = (
  messages: readonly AI.UIMessage[],
  state: 'input-available' | 'approval-responded',
): PendingToolCall[] => {
  // Scan back to the last assistant message rather than requiring the trailing
  // message to be one. A client steering message can arrive mid-run while a
  // tool-call pass is streaming; in raw run.messages order it sorts after the
  // assistant tool-call message, pushing it off the tail. An open tool_use must
  // still be resolved (its tool_result produced) before that steer can be
  // processed, so the pending calls we owe live on the last assistant, whatever
  // trails it.
  const last = messages.findLast((m) => m.role === 'assistant');
  if (last === undefined) return [];
  const result: PendingToolCall[] = [];
  for (const part of last.parts) {
    if (!isToolPart(part)) continue;
    if (part.state !== state) continue;
    if (part.input === undefined) continue;
    // `approval-responded` carries both approvals AND denials — the SDK reuses
    // the same state name for either outcome. A denied call must NOT be
    // dispatched to the tool-execute path, so gate on the boolean.
    if (state === 'approval-responded' && part.approval?.approved !== true) continue;
    result.push({
      toolCallId: part.toolCallId,
      toolName: getToolName(part),
      input: part.input,
    });
  }
  return result;
};
