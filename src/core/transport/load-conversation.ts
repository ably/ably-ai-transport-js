/**
 * Agent-side conversation reconstruction from the channel wire log.
 *
 * When an agent wakes (or resumes) it has no in-memory tree — it rebuilds the
 * state it needs by paging channel history and folding the wires through the
 * codec. Two entry points:
 *
 * - {@link loadRunProjection} — fold a single run's wires into one projection
 *   (used to resume a suspended run with its client tool-output amends).
 * - {@link loadConversation} — walk the structural parent chain from the
 *   current run's input node to the root and fold each node, producing the full
 *   multi-turn message history along the taken branch.
 *
 * Both reuse {@link foldMessageInto} (the shared per-message fold primitive) and
 * {@link buildBranchChain} (the shared parent-chain walk), so the agent's
 * reconstruction can't drift from the client/View decode paths.
 */

import * as Ably from 'ably';

import { EVENT_RUN_START, HEADER_PARENT, HEADER_RUN_ID, HEADER_TRANSPORT_MESSAGE_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { compareBySerial, getTransportHeaders } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import type { BranchChainNode } from './branch-chain.js';
import { buildBranchChain } from './branch-chain.js';
import { foldMessageInto } from './decode-fold.js';
import { isRunLifecycleName } from './headers.js';

// ---------------------------------------------------------------------------
// History collection + dedup
// ---------------------------------------------------------------------------

/**
 * Merge messages observed live (e.g. by the input-event lookup) into a set of
 * collected history messages, dedup by serial, and sort chronologically.
 *
 * History messages take priority in deduplication (history serial wins if the
 * same message appears in both). Messages without a serial are dropped because
 * they cannot be reliably ordered.
 * @param collected - Raw messages from channel.history (any order).
 * @param live - Messages observed live (e.g. by the input-event lookup); may be undefined.
 * @returns Deduplicated, chronologically sorted messages.
 */
export const withLiveMessages = (
  collected: readonly Ably.InboundMessage[],
  live?: readonly Ably.InboundMessage[],
): Ably.InboundMessage[] => {
  const seen = new Set<string>();
  const result: Ably.InboundMessage[] = [];
  for (const msg of collected) {
    if (msg.serial !== undefined && !seen.has(msg.serial)) {
      seen.add(msg.serial);
      result.push(msg);
    }
  }
  if (live !== undefined) {
    for (const msg of live) {
      if (msg.serial !== undefined && !seen.has(msg.serial)) {
        seen.add(msg.serial);
        result.push(msg);
      }
    }
  }
  return result.toSorted(compareBySerial);
};

/**
 * Page through a channel's history and collect raw messages, bounded so a
 * long-lived channel can't exhaust memory. No `untilAttach` — callers need
 * messages published after the channel first attached (e.g. client tool-output
 * amends on a suspended run).
 * @param channel - The Ably channel to read history from.
 * @param pageLimit - Messages requested per history page.
 * @param maxMessages - Stop paging once this many messages are collected.
 * @returns The collected messages in history order (newest first per Ably).
 */
const collectHistory = async (
  channel: Ably.RealtimeChannel,
  pageLimit: number,
  maxMessages: number,
): Promise<Ably.InboundMessage[]> => {
  const collected: Ably.InboundMessage[] = [];
  let page = await channel.history({ limit: pageLimit });
  collected.push(...page.items);
  while (page.hasNext() && collected.length < maxMessages) {
    const nextPage: Ably.PaginatedResult<Ably.InboundMessage> | null = await page.next();
    if (!nextPage) break;
    collected.push(...nextPage.items);
    page = nextPage;
  }
  return collected;
};

// ---------------------------------------------------------------------------
// Per-node folds
// ---------------------------------------------------------------------------

/**
 * Fold a pre-sorted array of wire messages for a single run into a projection.
 *
 * Skips lifecycle events (they carry no codec content) and stops before the
 * message whose `codec-message-id` equals `truncateAt` (exclusive — that
 * message is not folded). Used by both {@link loadRunProjection} (no
 * truncation) and {@link loadConversation} (per-ancestor folding).
 * @param codec - Codec used to decode and fold events.
 * @param sortedMessages - Chronologically ordered wire messages (all runs).
 * @param runId - Only messages stamped with this run-id are folded.
 * @param truncateAt - Stop before this codec-message-id; omit to fold all messages.
 * @returns The projection and the count of messages that were folded.
 */
export const foldRunMessages = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  codec: Codec<TInput, TOutput, TProjection, TMessage>,
  sortedMessages: readonly Ably.InboundMessage[],
  runId: string,
  truncateAt?: string,
): { projection: TProjection; folded: number } => {
  const decoder = codec.createDecoder();
  let projection = codec.init();
  let folded = 0;
  for (const msg of sortedMessages) {
    const h = getTransportHeaders(msg);
    if (h[HEADER_RUN_ID] !== runId) continue;
    if (isRunLifecycleName(msg.name)) continue;
    const codecMsgId = h[HEADER_TRANSPORT_MESSAGE_ID];
    if (truncateAt !== undefined && codecMsgId === truncateAt) break;
    projection = foldMessageInto(codec, decoder, projection, msg, codecMsgId ?? '');
    folded++;
  }
  return { projection, folded };
};

/**
 * Fold a single run-less INPUT node's events into a fresh projection: every
 * wire stamped with `codecMessageId` and NO run-id (the user prompt the client
 * published before the agent minted a run-id). The two-node analogue of
 * {@link foldRunMessages} for the user-input side of the conversation chain.
 * @param codec - Codec used to decode and fold events.
 * @param sortedMessages - Chronologically ordered wire messages (all runs).
 * @param codecMessageId - The input node's codec-message-id.
 * @returns The folded projection for that input node.
 */
export const foldInputMessages = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  codec: Codec<TInput, TOutput, TProjection, TMessage>,
  sortedMessages: readonly Ably.InboundMessage[],
  codecMessageId: string,
): TProjection => {
  const decoder = codec.createDecoder();
  let projection = codec.init();
  for (const msg of sortedMessages) {
    const h = getTransportHeaders(msg);
    if (h[HEADER_RUN_ID] !== undefined) continue;
    if (h[HEADER_TRANSPORT_MESSAGE_ID] !== codecMessageId) continue;
    projection = foldMessageInto(codec, decoder, projection, msg, codecMessageId);
  }
  return projection;
};

// ---------------------------------------------------------------------------
// Run-state reconstruction
// ---------------------------------------------------------------------------

/**
 * Fetch all messages on the channel that belong to `runId`, decode them
 * through the codec, and fold them into a single projection. Used by the agent
 * to reconstruct a run's full state — including client-published tool-output
 * amends — when resuming a suspended run in a fresh agent session.
 *
 * Doesn't require channel rewind: an explicit `channel.history()` call returns
 * the same data even if the channel is already attached from a prior session.
 * @param opts - Load parameters.
 * @param opts.channel - The Ably channel to read history from.
 * @param opts.codec - Codec used to decode and fold events.
 * @param opts.runId - Run identifier whose events should be folded.
 * @param opts.signal - AbortSignal that cancels the wait when the run is cancelled.
 * @param opts.logger - Optional logger for diagnostic output.
 * @param opts.liveMessages - Raw Ably messages already observed live (e.g. by
 *   the input-event lookup). Folded alongside the history fetch so just-published
 *   client wires don't depend on Ably's history-indexing window.
 * @returns The projection produced by folding all run events in serial order.
 */
export const loadRunProjection = async <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(opts: {
  channel: Ably.RealtimeChannel;
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  runId: string;
  signal: AbortSignal;
  logger: Logger | undefined;
  liveMessages?: readonly Ably.InboundMessage[];
}): Promise<TProjection> => {
  const { channel, codec, runId, signal, logger, liveMessages } = opts;

  if (signal.aborted) {
    throw new Ably.ErrorInfo(
      `unable to load run projection; run ${runId} was cancelled`,
      ErrorCode.InvalidArgument,
      400,
    );
  }

  await channel.attach();

  // 2000 wire messages is generously more than any single run could produce.
  const collected = await collectHistory(channel, 200, 2000);

  const sorted = withLiveMessages(collected, liveMessages);
  const { projection, folded } = foldRunMessages(codec, sorted, runId);

  logger?.debug('loadRunProjection(); folded run events', { runId, folded });
  return projection;
};

/** A node in the reconstruction index — {@link BranchChainNode} plus its run-id. */
interface NodeMeta extends BranchChainNode {
  /** The run-id this node belongs to, or undefined for a run-less input node. */
  runId: string | undefined;
}

/**
 * Reconstruct the full multi-turn conversation history along the branch the
 * current run sits on.
 *
 * Pages channel history (merging live lookup messages), indexes each
 * codec-message-id's structural parent and run-id with sticky identity (the
 * first wire wins; later amends can't poison it), backfills a reply run's
 * parent from its `ai-run-start` when the output wire wasn't indexed, then
 * walks the structural parent chain from the current run's input node
 * (`assistantParentFallback`) to the root and folds each node in chain order.
 * The current run is folded once, wholesale, at the tail.
 * @param opts - Reconstruction parameters.
 * @param opts.channel - The Ably channel to read history from.
 * @param opts.codec - Codec used to decode and fold events.
 * @param opts.runId - The current run's id.
 * @param opts.signal - AbortSignal that cancels the load when the run is cancelled.
 * @param opts.logger - Optional logger for diagnostic output.
 * @param opts.liveMessages - Wires already observed live, merged into history.
 * @param opts.assistantParentFallback - The current run's input node
 *   (codec-message-id) — the anchor the parent-chain walk starts from. When
 *   undefined, only the current run is folded.
 * @param opts.pageLimit - Messages requested per history page.
 * @param opts.maxMessages - Stop paging once this many messages are collected.
 * @returns The branch's messages (root-first) and the current run's projection.
 */
export const loadConversation = async <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(opts: {
  channel: Ably.RealtimeChannel;
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  runId: string;
  signal: AbortSignal;
  logger: Logger | undefined;
  liveMessages: readonly Ably.InboundMessage[] | undefined;
  assistantParentFallback: string | undefined;
  pageLimit: number;
  maxMessages: number;
}): Promise<{ messages: TMessage[]; projection: TProjection }> => {
  const { channel, codec, runId, signal, logger, liveMessages, assistantParentFallback, pageLimit, maxMessages } = opts;

  if (signal.aborted) {
    throw new Ably.ErrorInfo(`unable to load conversation; run ${runId} was cancelled`, ErrorCode.InvalidArgument, 400);
  }

  // Single channel.history() fetch for all runs. Live lookup messages are
  // merged in so the current run's just-published client wires don't depend on
  // Ably's history-indexing window. Deduped by serial (history wins), sorted.
  const collected = await collectHistory(channel, pageLimit, maxMessages);
  const sortedMessages = withLiveMessages(collected, liveMessages);

  // Index pass — node metadata per codec-message-id from the serial-sorted
  // history, with sticky identity (the first wire for a codec-message-id wins
  // for the structural parent; a later amend can't poison it). Run-bearing
  // wires record their runId; run-less user inputs are input nodes (runId
  // undefined).
  const nodeMeta = new Map<string, NodeMeta>();
  const runIdToCodecMessageId = new Map<string, string>();
  for (const msg of sortedMessages) {
    if (isRunLifecycleName(msg.name)) continue;
    const h = getTransportHeaders(msg);
    const cid = h[HEADER_TRANSPORT_MESSAGE_ID];
    if (cid === undefined) continue;
    const msgRunId = h[HEADER_RUN_ID];
    if (msgRunId !== undefined) runIdToCodecMessageId.set(msgRunId, cid);
    if (!nodeMeta.has(cid)) {
      nodeMeta.set(cid, { runId: msgRunId, parentCodecMessageId: h[HEADER_PARENT] });
    }
  }
  // Backfill a reply run's structural parent from ai-run-start when its output
  // wire wasn't indexed (rare history lag). Keyed by runId → codec-message-id.
  for (const msg of sortedMessages) {
    if (msg.name !== EVENT_RUN_START) continue;
    const h = getTransportHeaders(msg);
    const msgRunId = h[HEADER_RUN_ID];
    if (msgRunId === undefined) continue;
    const cid = runIdToCodecMessageId.get(msgRunId);
    if (cid === undefined) continue;
    const meta = nodeMeta.get(cid);
    if (meta && meta.parentCodecMessageId === undefined) meta.parentCodecMessageId = h[HEADER_PARENT];
  }

  // Walk the structural parent chain from the current run's input node up to
  // the conversation root, then fold each node in chain order. The upward walk
  // naturally excludes un-taken branch siblings (an edit's alternate prompt, a
  // regenerate's superseded reply), so no per-ancestor truncation is needed.
  // (Open caveat, deferred with a golden test: regenerating a non-trailing
  // message of a multi-message reply — the node walk can't slice inside one
  // run's projection.)
  const messages: TMessage[] = [];
  let chainLength = 0;
  if (assistantParentFallback !== undefined) {
    const chain = buildBranchChain(nodeMeta, assistantParentFallback);
    chainLength = chain.length;
    for (const cid of chain) {
      const meta = nodeMeta.get(cid);
      // Skip any chain node belonging to the CURRENT run — it is folded once,
      // wholesale, at the tail below. For a continuation the run-id is reused
      // and `assistantParentFallback` points at a message INSIDE the current
      // run, so it would otherwise be folded twice and emit duplicate tool_use
      // ids.
      if (meta?.runId === runId) continue;
      const projection =
        meta?.runId === undefined
          ? foldInputMessages(codec, sortedMessages, cid)
          : foldRunMessages(codec, sortedMessages, meta.runId).projection;
      messages.push(...codec.getMessages(projection).map((m) => m.message));
    }
  }

  // Current run — folded from the same sorted messages, appended at the chain
  // tail (the chain ended at this run's input node).
  const { projection, folded } = foldRunMessages(codec, sortedMessages, runId);
  messages.push(...codec.getMessages(projection).map((m) => m.message));

  logger?.debug('loadConversation(); built', { runId, chainLength, totalMessages: messages.length, folded });
  return { messages, projection };
};
