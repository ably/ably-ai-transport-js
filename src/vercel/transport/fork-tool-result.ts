/**
 * Fork a client tool-result into its own reply run.
 *
 * A client that resolves a suspended tool call should open a NEW reply run — a
 * fork — rather than re-entering the suspended run, so that concurrent answers
 * to the same tool call (e.g. two browser tabs sharing one `clientId`) become
 * segregated sibling branches instead of colliding on the shared run. This is
 * what the useChat chat-transport adapter does internally; {@link createToolResultFork}
 * exposes the same construction for callers that drive `view.send` directly
 * (e.g. the generic-hooks / `useClientSession` path).
 *
 * The returned input addresses a FRESH assistant codec-message-id and carries a
 * self-contained {@link ForkSeed} — a copy of the suspended run's FULL message
 * list, each entry under a fresh client-minted codec-message-id — so the fork
 * run's reducer reconstructs the whole run (prior resolved tool calls included)
 * carrying THIS result before the agent resumes. Seeding the whole run, not just
 * the current tool-call assistant, keeps context across SEQUENTIAL client tool
 * calls. The fork is published RUN-LESS: the returned send options carry the
 * fork's structural `parent` (the suspended run's input node) and
 * `role: 'assistant'`, but NO run-id — the AGENT mints the fork's run-id on
 * `ai-run-start`, and the tree reconciles this client's optimistic reply run
 * onto it by the tool-result's codec-message-id. `parent` makes the fork a
 * same-parent sibling of the suspended run; `role: 'assistant'` marks the
 * run-less input as a reconstructed assistant turn (a reply run) rather than a
 * user input node. Publish them together:
 *
 * ```ts
 * const codec = createUIMessageSessionCodec();
 * const run = view.runOf(codecMessageId);
 * const node = getRunNode(run.runId);
 * const { input, sendOptions } = createToolResultFork({
 *   runMessages: codec.getMessages(node.projection),
 *   parentCodecMessageId: node.parentCodecMessageId,
 *   toolCallId,
 *   result: { output },
 *   supersedesRunId: node.runId,
 * });
 * const forked = await view.send([input], sendOptions);
 * ```
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import type { CodecMessage } from '../../core/transport/session-codec.js';
import type { SendOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import { createUIMessageSessionCodec } from '../codec/session-codec.js';
import type { ForkSeed, VercelSessionInput } from '../codec/session-events.js';
import { isToolPart } from '../tool-part.js';

// The well-known input factories (`createToolResult` / `createToolResultError`)
// are exposed on a codec instance. This helper is a pure function with no codec
// in scope, so assemble one at module load (the codec is stateless — the same
// idiom the React provider uses for its default codec).
const codec = createUIMessageSessionCodec();

/**
 * The resolution a client produced for a suspended tool call — either a
 * successful `output` or a failure `errorMessage`. Exactly one is set.
 */
export type ToolCallResolution = { output: unknown } | { errorMessage: string };

/**
 * Build the input + send options to fork a client tool-result into its own
 * reply run (see the module header). A fresh codec-message-id is minted per
 * `runMessages` entry, so two independent calls (e.g. two tabs) reconstruct two
 * independent branches; the fork is published run-less and the AGENT mints each
 * fork's run-id.
 * @param params - The fork inputs.
 * @param params.runMessages - The suspended run's full message list (its
 *   projection via `codec.getMessages(node.projection)`). Each entry is
 *   reconstructed under a fresh id so the fork run is self-contained with full
 *   history; the entry carrying `toolCallId` is the result's target.
 * @param params.parentCodecMessageId - The fork's structural parent — the
 *   suspended run's own input node (`getRunNode(run.runId)?.parentCodecMessageId`,
 *   NOT a positional guess). Required: it roots the run-less fork as a
 *   same-parent sibling of the suspended run (so segregated concurrent forks
 *   group under one input node) rather than a detached root.
 * @param params.toolCallId - The tool call being resolved.
 * @param params.result - The resolution: `{ output }` for success or `{ errorMessage }` for failure.
 * @param params.supersedesRunId - The run-id of the suspended run this fork
 *   resolves (`getRunNode(run.runId)?.runId`). The fork supersedes it: that run
 *   is now dead (nothing resumes it), so the tree hides it from branch
 *   selection — a single client's single response renders as ONE linear reply,
 *   while genuinely concurrent forks (each superseding the same run) still
 *   branch. Omitting it would leave the dead trunk showing as a spurious sibling.
 * @returns The fork input and the run-less send options (`parent` + `role: 'assistant'` + `supersedes`, no run-id) to pass to `view.send([input], sendOptions)`.
 * @throws {Ably.ErrorInfo} When no `runMessages` entry carries `toolCallId` — an invalid fork.
 */
export const createToolResultFork = (params: {
  runMessages: CodecMessage<AI.UIMessage>[];
  parentCodecMessageId: string;
  toolCallId: string;
  result: ToolCallResolution;
  supersedesRunId: string;
}): { input: VercelSessionInput; sendOptions: SendOptions } => {
  const { runMessages, parentCodecMessageId, toolCallId, result, supersedesRunId } = params;

  // Mint a fresh codec-message-id per run message, preserving each message. The
  // seed carries the WHOLE run so the fork projection reconstructs full history,
  // and the target's fresh id becomes the fork run's client-owned key until the
  // agent mints the run-id.
  const seed: ForkSeed = {
    messages: runMessages.map((rm) => ({ codecMessageId: crypto.randomUUID(), message: rm.message })),
  };

  // The result's target is the fresh id of the seed message carrying this tool
  // call. If none does, the fork is invalid (the run does not own the call).
  const targetEntry = seed.messages.find((entry) =>
    entry.message.parts.some((p) => isToolPart(p) && p.toolCallId === toolCallId),
  );
  if (!targetEntry) {
    throw new Ably.ErrorInfo(
      `unable to fork tool result; no run message carries toolCallId ${toolCallId}`,
      ErrorCode.InvalidArgument,
      400,
    );
  }
  const target = targetEntry.codecMessageId;

  const input: VercelSessionInput =
    'errorMessage' in result
      ? codec.createToolResultError(target, { toolCallId, message: result.errorMessage, forkSeed: seed })
      : codec.createToolResult(target, { toolCallId, output: result.output, forkSeed: seed });

  // Run-less: NO run-id (the agent mints the fork's run-id on `ai-run-start`).
  // `role: 'assistant'` marks the run-less input as a reconstructed assistant
  // turn, so the tree classifies it as an optimistic reply run — not a user
  // input node — and reconciles it onto the agent-minted run-id. `supersedes`
  // marks the resolved suspended run dead so the tree hides it from branch
  // selection (single response → linear; concurrent forks → branches).
  const sendOptions: SendOptions = {
    parent: parentCodecMessageId,
    role: 'assistant',
    supersedes: supersedesRunId,
  };

  return { input, sendOptions };
};
