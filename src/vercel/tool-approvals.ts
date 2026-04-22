/**
 * Server-side helpers for processing a tool-approval turn.
 *
 * When a Vercel AI SDK tool is marked `needsApproval`, `streamText` pauses
 * after emitting a `dynamic-tool` part in state `approval-requested`. To
 * resume, the server must:
 *
 *   1. Patch the UIMessage history so the pending tool part reflects the
 *      user's decision (`approval-responded` or `output-denied`).
 *   2. Strip the client-appended "Approved: …" user message, because
 *      `streamText`'s multi-step loop only auto-executes pending tool
 *      calls when the conversation ends on a tool/assistant message.
 *   3. Disable `needsApproval` on just-approved tools so the multi-step
 *      loop doesn't immediately pause again on the same tool.
 *   4. Redirect the resulting `tool-output-available` / `tool-output-error`
 *      chunks back to the ORIGINAL assistant message (the one that held
 *      the `approval-requested` part) via `x-ably-amend`, instead of
 *      letting them land on the new assistant message this turn produces.
 *
 * `prepareApprovalTurn` covers steps 1–3; `streamResponseWithApprovalRedirect`
 * covers step 4.
 */

import type * as AI from 'ai';
import { convertToModelMessages } from 'ai';

import { HEADER_AMEND } from '../constants.js';
import type { MessageNode, StreamResponseOptions, StreamResult, Turn } from '../core/transport/types.js';
import { stripUndefined } from '../utils.js';
import { toolBase } from './codec/tool-transitions.js';

// ---------------------------------------------------------------------------
// Tool-part transition helpers (private — only used by applyToolApprovalsToHistory)
// ---------------------------------------------------------------------------

// Build the `approval-responded` variant of a DynamicToolUIPart. Pure.
const applyApprovalResponseToPart = (
  part: AI.DynamicToolUIPart,
  approvalId: string,
  approved: boolean,
  reason: string | undefined,
): AI.DynamicToolUIPart =>
  stripUndefined({
    ...toolBase(part),
    state: 'approval-responded' as const,
    input: part.input,
    approval: stripUndefined({ id: approvalId, approved, reason }),
  });

// Build the `output-denied` variant of a DynamicToolUIPart. Pure.
const applyApprovalDeniedToPart = (part: AI.DynamicToolUIPart, approvalId: string): AI.DynamicToolUIPart => ({
  ...toolBase(part),
  state: 'output-denied',
  input: part.input,
  approval: { id: approvalId, approved: false as const },
});

// ---------------------------------------------------------------------------
// Wire type
// ---------------------------------------------------------------------------

/**
 * A user's decision on a pending tool approval. The client ships an array of
 * these to the server in the POST body; the server feeds them to
 * `prepareApprovalTurn` (to patch history) and
 * `streamResponseWithApprovalRedirect` (to route tool outputs back to the
 * original assistant message).
 *
 * Intentionally does not carry `toolName` or `input` — those are redundant
 * with what's already on the UIMessage history part.
 */
export interface ToolApprovalDecision {
  /**
   * The `toolCallId` of the pending `dynamic-tool` part being approved/denied.
   * Must match a part already in the history; decisions that don't match any
   * part are ignored by {@link applyToolApprovalsToHistory}.
   */
  toolCallId: string;
  /** Whether the user approved or denied the tool call. */
  approved: boolean;
  /**
   * The `x-ably-msg-id` of the assistant message whose `dynamic-tool` part
   * is being responded to. When approved and the tool executes successfully,
   * the output is published cross-turn targeting this message.
   */
  targetMsgId: string;
  /** Optional reason accompanying the response. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// History patching
// ---------------------------------------------------------------------------

/**
 * Patch `dynamic-tool` parts in the history to reflect a batch of approval
 * decisions. Pure — returns a new array; input is not mutated.
 *
 * Approved decisions transition the matching part to `approval-responded`,
 * which `convertToModelMessages` will expand into a `tool-approval-response`
 * model message for `streamText`'s multi-step loop. Denied decisions
 * transition to `output-denied`.
 *
 * Messages and parts whose `toolCallId` is not referenced by any decision
 * are passed through by reference.
 * @param messages - The UIMessage history (user + assistant messages).
 * @param decisions - Approval decisions keyed by `toolCallId`.
 * @returns A new array with matching tool parts transitioned.
 */
export const applyToolApprovalsToHistory = (
  messages: AI.UIMessage[],
  decisions: ToolApprovalDecision[],
): AI.UIMessage[] => {
  if (decisions.length === 0) return messages;
  const byToolCallId = new Map(decisions.map((d) => [d.toolCallId, d]));

  return messages.map((msg) => {
    let patchedParts: AI.UIMessage['parts'] | undefined;

    for (const [index, part] of msg.parts.entries()) {
      if (part.type !== 'dynamic-tool') continue;
      const decision = byToolCallId.get(part.toolCallId);
      if (!decision) continue;

      // Preserve an existing approval id if the part already has one
      // (it was set when the approval-request chunk arrived); otherwise mint
      // a new id so the emitted tool-approval-response has a stable handle.
      const approvalId = part.approval?.id ?? crypto.randomUUID();
      const replacement = decision.approved
        ? applyApprovalResponseToPart(part, approvalId, true, decision.reason)
        : applyApprovalDeniedToPart(part, approvalId);

      patchedParts ??= [...msg.parts];
      patchedParts[index] = replacement;
    }

    return patchedParts ? { ...msg, parts: patchedParts } : msg;
  });
};

// ---------------------------------------------------------------------------
// Tool manipulation
// ---------------------------------------------------------------------------

/**
 * Derive the set of tool names that have just been approved by walking the
 * (pre-patch) history for `dynamic-tool` parts whose `toolCallId` matches an
 * approved decision.
 * @param messages - The full UIMessage history.
 * @param decisions - Approval decisions for this request.
 * @returns The set of tool names that were just approved.
 */
const approvedToolNames = (messages: AI.UIMessage[], decisions: ToolApprovalDecision[]): Set<string> => {
  const approvedIds = new Set(decisions.filter((d) => d.approved).map((d) => d.toolCallId));
  if (approvedIds.size === 0) return new Set();

  const names = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'dynamic-tool' && approvedIds.has(part.toolCallId)) {
        names.add(part.toolName);
      }
    }
  }
  return names;
};

/**
 * Return a tool dict with `needsApproval: false` forced on any tool whose
 * name is in `approvedNames`. Prevents an infinite approval loop when
 * `streamText`'s multi-step loop calls an approved tool again after
 * executing it.
 *
 * The generic uses `object` (not `AI.Tool`) for its value constraint so
 * duplicate peer-dep resolutions — common when the SDK and the consuming app
 * each pull their own copy of `ai` — still type-check. Every real Vercel Tool
 * is structurally an object, so the constraint holds in practice.
 * @param tools - The tool dictionary.
 * @param approvedNames - Names of tools whose `needsApproval` should be disabled.
 * @returns A new tool dict with the flag cleared on matching entries; input returned unchanged when the set is empty.
 */
const disableApprovalFor = <T extends Record<string, object>>(tools: T, approvedNames: ReadonlySet<string>): T => {
  if (approvedNames.size === 0) return tools;
  const entries = Object.entries(tools).map(([name, def]) =>
    approvedNames.has(name) ? ([name, { ...def, needsApproval: false }] as const) : ([name, def] as const),
  );
  // CAST: Object.fromEntries loses the exact T shape in its return type, but
  // we preserve every key and only set an existing optional field, so the T
  // contract holds at runtime.
  return Object.fromEntries(entries) as T;
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Options for {@link prepareApprovalTurn}. */
export interface PrepareApprovalTurnOptions<T extends Record<string, object>> {
  /** The full UIMessage history (user + assistant messages for this conversation). */
  messages: AI.UIMessage[];
  /** The user's approval decisions for this request, if any. */
  decisions: ToolApprovalDecision[] | undefined;
  /**
   * The tool dictionary that will be passed to `streamText`. Typed with a
   * structural `object` value constraint so it accepts `Record<string, Tool>`
   * regardless of which copy of the `ai` peer dep typed it.
   */
  tools: T;
}

/** Result of {@link prepareApprovalTurn}. */
export interface PrepareApprovalTurnResult<T extends Record<string, object>> {
  /** Model-format messages ready to pass to `streamText({ messages })`. */
  modelMessages: AI.ModelMessage[];
  /** Tools with `needsApproval` disabled for any tool that was just approved. */
  tools: T;
}

/**
 * One-shot transform to ready a history + tool dict for a `streamText` call
 * on an approval turn. Returns the patched model-message array and the
 * effective tools dict.
 *
 * When `decisions` is absent or empty, this is a thin wrapper around
 * `convertToModelMessages(messages)` that returns the original tools — so
 * callers can use it uniformly regardless of whether the request carries
 * approvals.
 * @param options - See {@link PrepareApprovalTurnOptions}.
 * @returns See {@link PrepareApprovalTurnResult}.
 */
export const prepareApprovalTurn = async <T extends Record<string, object>>(
  options: PrepareApprovalTurnOptions<T>,
): Promise<PrepareApprovalTurnResult<T>> => {
  const { messages, decisions, tools } = options;

  if (!decisions || decisions.length === 0) {
    return { modelMessages: await convertToModelMessages(messages), tools };
  }

  const patched = applyToolApprovalsToHistory(messages, decisions);
  const converted = await convertToModelMessages(patched);

  // Strip the client-appended "Approved: …" / "Denied: …" user message so
  // `streamText`'s multi-step loop auto-executes the pending tool call.
  const modelMessages = converted.at(-1)?.role === 'user' ? converted.slice(0, -1) : converted;

  const effectiveTools = disableApprovalFor(tools, approvedToolNames(messages, decisions));

  return { modelMessages, tools: effectiveTools };
};

// ---------------------------------------------------------------------------
// Stream response with cross-turn redirect
// ---------------------------------------------------------------------------

/** Options for {@link streamResponseWithApprovalRedirect}. */
export interface StreamResponseWithApprovalRedirectOptions extends StreamResponseOptions<AI.UIMessageChunk> {
  /**
   * The approval decisions this turn is resolving. Only approved decisions
   * redirect tool outputs — denied decisions have already been reflected
   * in the history and produce no tool output to capture.
   */
  decisions: ToolApprovalDecision[] | undefined;
}

/**
 * Pipe a UIMessage chunk stream through the turn's encoder, but redirect
 * `tool-output-available` / `tool-output-error` chunks for approved tools to
 * the original assistant message via `x-ably-amend`.
 *
 * Without this redirect, the tool output would land on the new assistant
 * message produced this turn — leaving the original message stuck in
 * `approval-responded` state. The redirect uses a per-event
 * {@link StreamResponseOptions.resolveWriteOptions} hook: when a matching
 * chunk reaches the encoder, it is published with the target's `msgId`
 * and an `x-ably-amend` header so the client merges the output onto the
 * original message instead of the current-turn one.
 *
 * To preserve "no amendments on cancel" semantics — a partial turn must
 * not leave torn-off tool outputs on the original message — redirect-
 * target chunks are held in a small TransformStream buffer and only
 * released to the encoder when the source stream closes normally. If the
 * turn's `abortSignal` fires before the flush, the buffer is discarded.
 * Non-redirect chunks are enqueued inline and are unaffected by the buffer.
 * @param turn - The active server turn.
 * @param stream - The UIMessage chunk stream to pipe through the encoder.
 * @param options - Stream options plus the approval decisions to redirect.
 * @returns The underlying `streamResponse` result.
 */
// The redirect-eligible subset of UIMessageChunk — narrow enough for the type
// guard below to tell TypeScript that `event.toolCallId` is defined.
type RedirectTargetChunk = Extract<AI.UIMessageChunk, { type: 'tool-output-available' | 'tool-output-error' }>;

export const streamResponseWithApprovalRedirect = (
  turn: Turn<AI.UIMessageChunk, AI.UIMessage>,
  stream: ReadableStream<AI.UIMessageChunk>,
  options: StreamResponseWithApprovalRedirectOptions,
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- body only returns other promises; an async wrapper would add a pointless microtask hop
): Promise<StreamResult> => {
  const { decisions, ...streamOptions } = options;

  const targets = new Map<string, string>();
  for (const decision of decisions ?? []) {
    if (decision.approved) targets.set(decision.toolCallId, decision.targetMsgId);
  }

  if (targets.size === 0) return turn.streamResponse(stream, streamOptions);

  const isRedirectTarget = (event: AI.UIMessageChunk): event is RedirectTargetChunk =>
    (event.type === 'tool-output-available' || event.type === 'tool-output-error') && targets.has(event.toolCallId);

  const buffer: AI.UIMessageChunk[] = [];
  const guarded = stream.pipeThrough(
    new TransformStream<AI.UIMessageChunk, AI.UIMessageChunk>({
      transform: (chunk, controller) => {
        if (isRedirectTarget(chunk)) {
          buffer.push(chunk);
          return;
        }
        controller.enqueue(chunk);
      },
      flush: (controller) => {
        if (turn.abortSignal.aborted) return;
        for (const chunk of buffer) controller.enqueue(chunk);
      },
    }),
  );

  return turn.streamResponse(guarded, {
    ...streamOptions,
    resolveWriteOptions: (event) => {
      if (!isRedirectTarget(event)) return;
      const target = targets.get(event.toolCallId);
      if (target === undefined) return;
      return { messageId: target, extras: { headers: { [HEADER_AMEND]: target } } };
    },
  });
};

// ---------------------------------------------------------------------------
// History-scan helper (useChat-style routes)
// ---------------------------------------------------------------------------

/**
 * Walk the conversation history and synthesize a {@link ToolApprovalDecision}
 * for each `dynamic-tool` part in `approval-responded` (approved) or
 * `output-denied` (denied) state.
 *
 * Use in server routes where the client flips the tool part state directly
 * (via useChat's `addToolApprovalResponse` and our
 * `useStagedAddToolApprovalResponse`) and ships it through the history
 * overlay instead of a separate `toolApprovals` body field.
 * @param history - The conversation history nodes from the POST body.
 * @returns Approval decisions derived from the history, in walk order.
 */
export const extractApprovalDecisionsFromHistory = (
  history: readonly MessageNode<AI.UIMessage>[],
): ToolApprovalDecision[] => {
  const decisions: ToolApprovalDecision[] = [];
  for (const node of history) {
    for (const part of node.message.parts) {
      if (part.type !== 'dynamic-tool') continue;
      if (part.state === 'approval-responded') {
        decisions.push({
          toolCallId: part.toolCallId,
          approved: true,
          targetMsgId: node.msgId,
          ...(part.approval.reason === undefined ? {} : { reason: part.approval.reason }),
        });
      } else if (part.state === 'output-denied') {
        decisions.push({
          toolCallId: part.toolCallId,
          approved: false,
          targetMsgId: node.msgId,
        });
      }
    }
  }
  return decisions;
};
