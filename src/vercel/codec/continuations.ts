/**
 * Continuation routing and materialisation for the recursive
 * {@link VercelProjection}.
 *
 * A client-side tool call can be executed and continued by more than one
 * responder at once (e.g. two browser tabs sharing a `clientId`). Rather than
 * let their results compete for one tool part — and their follow-ups
 * contaminate one another's reconstructed history — the reducer routes each
 * responder's tool-result + follow-up into its own CONTINUATION: a nested
 * sub-projection keyed by the triggering input's `event-id` (the per-send
 * `input-event-id` the agent echoes). The branching lives inside the codec
 * projection; the generic Tree stores the projection opaquely.
 *
 * This module owns three concerns:
 * - {@link routeInput} / {@link routeOutput}: pick the node a fold lands in —
 *   the base node or one of its (possibly nested) continuations.
 * - {@link materialize}: walk root→leaf applying the canonical (or
 *   selector-directed) pick at each branch to produce the visible message list.
 *
 * Per-send grain: each `tool-result` opens exactly one continuation (a client
 * executes a given tool call once — `handledRef` guards re-execution — and
 * publishes once), so a single responder never splits into siblings.
 */

import type * as AI from 'ai';

import type { MessageSelector } from '../../core/codec/index.js';
import type { VercelInput } from './events.js';
import type { Continuation, MessageTrackers, VercelProjection } from './reducer-state.js';

/**
 * Tool-part states that still await a result. A continuation attaches at the
 * node whose tail assistant holds the tool call in one of these states (the
 * unresolved "home"); a resolved COPY of that assistant inside a continuation
 * is never itself an attach point.
 */
const UNRESOLVED_TOOL_STATES = new Set<AI.DynamicToolUIPart['state']>([
  'input-streaming',
  'input-available',
  'approval-requested',
]);

/**
 * Whether an input opens a continuation — a client executed a tool call and is
 * continuing the run. Approval responses and user messages do not branch.
 * @param input - The decoded client input.
 * @returns True for `tool-result` / `tool-result-error`.
 */
const isContinuationSeed = (input: VercelInput): boolean =>
  input.kind === 'tool-result' || input.kind === 'tool-result-error';

/**
 * Whether `message`'s tail tool call for `toolCallId` is still unresolved, i.e.
 * this message is the live attach point for a continuation resolving it.
 * @param message - The candidate home message.
 * @param toolCallId - The tool call a resolution targets.
 * @returns True when `message` holds that tool call awaiting a result.
 */
const hasUnresolvedToolCall = (message: AI.UIMessage, toolCallId: string): boolean =>
  message.parts.some(
    (p): p is AI.DynamicToolUIPart =>
      p.type === 'dynamic-tool' && p.toolCallId === toolCallId && UNRESOLVED_TOOL_STATES.has(p.state),
  );

/**
 * Find the node a continuation resolving `(codecMessageId, toolCallId)` attaches
 * under: the node whose OWN tail message is that assistant with the tool call
 * still unresolved. DFS over the base node and every nested continuation. The
 * resolved copies inside sibling continuations are skipped (their tool part is
 * already resolved), so the result is unambiguous.
 * @param node - The node to search from (root for a top-level resolution).
 * @param codecMessageId - The assistant codec-message-id the resolution targets.
 * @param toolCallId - The tool call being resolved.
 * @returns The home node, or `undefined` when the target assistant is not yet present.
 */
const findHomeNode = (
  node: VercelProjection,
  codecMessageId: string,
  toolCallId: string,
): VercelProjection | undefined => {
  const tail = node.messages.at(-1);
  if (tail?.codecMessageId === codecMessageId && hasUnresolvedToolCall(tail.message, toolCallId)) {
    return node;
  }
  for (const continuation of node.continuations.values()) {
    const found = findHomeNode(continuation.projection, codecMessageId, toolCallId);
    if (found) return found;
  }
  return undefined;
};

/**
 * Find the sub-projection of the continuation keyed by `eventId`, anywhere in
 * the (possibly nested) continuation tree under `node`.
 * @param node - The node to search from.
 * @param eventId - The continuation key (a triggering input event-id).
 * @returns The continuation's projection, or `undefined` if no such continuation exists.
 */
const findContinuation = (node: VercelProjection, eventId: string): VercelProjection | undefined => {
  const direct = node.continuations.get(eventId);
  if (direct) return direct.projection;
  for (const continuation of node.continuations.values()) {
    const found = findContinuation(continuation.projection, eventId);
    if (found) return found;
  }
  return undefined;
};

/**
 * Seed a fresh continuation sub-projection from its home node: a deep copy of
 * the home's tail assistant (the as-yet-unresolved tool call) plus that
 * message's stream tracker, so a subsequent resolution fold transitions the
 * COPY — leaving the base assistant untouched for sibling continuations.
 * @param home - The node whose tail assistant the continuation resolves.
 * @returns A new sub-projection holding the copied assistant.
 */
const seedContinuation = (home: VercelProjection): VercelProjection => {
  const tail = home.messages.at(-1);
  // findHomeNode guarantees a tail; the guard keeps this total for the type checker.
  if (!tail) {
    return { messages: [], trackers: new Map(), pendingToolResolutions: [], continuations: new Map() };
  }
  const trackers = new Map<string, MessageTrackers>();
  const homeTracker = home.trackers.get(tail.codecMessageId);
  if (homeTracker) {
    trackers.set(tail.codecMessageId, {
      text: new Map(homeTracker.text),
      reasoning: new Map(homeTracker.reasoning),
      tools: new Map(Array.from(homeTracker.tools, ([id, t]) => [id, { ...t }])),
    });
  }
  return {
    messages: [{ codecMessageId: tail.codecMessageId, message: structuredClone(tail.message) }],
    trackers,
    pendingToolResolutions: [],
    continuations: new Map(),
  };
};

/**
 * Pick the node a client-published INPUT folds into. A `tool-result` /
 * `tool-result-error` carrying a wire `event-id` (in `meta`, surfaced as
 * `seedEventId`) opens (or re-enters) the continuation keyed by it, under the
 * home node holding the targeted tool call. Everything else — user messages,
 * approval responses, or a resolution with no event-id (a bare unit fold) —
 * folds into `base`, preserving the flat behaviour.
 * @param base - The run's root projection.
 * @param input - The decoded client input.
 * @param seedEventId - The wire `event-id` of this input (`meta.eventId`), or undefined.
 * @param serial - The wire's canonical serial (for continuation ordering).
 * @returns The node the input's fold should target.
 */
export const routeInput = (
  base: VercelProjection,
  input: VercelInput,
  seedEventId: string | undefined,
  serial: string,
): VercelProjection => {
  if (seedEventId === undefined || !isContinuationSeed(input) || input.codecMessageId === undefined) {
    return base;
  }
  const toolCallId = 'payload' in input ? input.payload.toolCallId : undefined;
  if (toolCallId === undefined) return base;

  const existing = base.continuations.size > 0 ? findContinuationOwner(base, seedEventId) : undefined;
  if (existing) {
    // A continuation already keyed by this event-id: keep the lowest serial as
    // the canonical-order anchor. (Tool-results always carry a real serial.)
    if (serial < existing.seedSerial) existing.seedSerial = serial;
    return existing.projection;
  }

  const home = findHomeNode(base, input.codecMessageId, toolCallId);
  // Home not present — the targeted assistant has not folded yet. In canonical
  // order this cannot happen for a tool-result: a client only resolves a tool
  // call after observing it, so the assistant precedes its own tool-result by
  // serial and is folded first on both the incremental-tail and refold paths.
  // This is a defensive fallback for a pathological out-of-order live delivery;
  // the resolution then buffers in `base.pendingToolResolutions` and (only if
  // the assistant somehow arrives in-order afterwards, which the invariant
  // rules out) would resolve onto base flat rather than into a continuation.
  if (!home) return base;

  const continuation: Continuation = { seedSerial: serial, projection: seedContinuation(home) };
  home.continuations.set(seedEventId, continuation);
  return continuation.projection;
};

/**
 * Find the {@link Continuation} entry (not just its projection) keyed by
 * `eventId`, anywhere under `node` — used to update its `seedSerial` on
 * re-delivery.
 * @param node - The node to search from.
 * @param eventId - The continuation key.
 * @returns The continuation entry, or `undefined`.
 */
const findContinuationOwner = (node: VercelProjection, eventId: string): Continuation | undefined => {
  const direct = node.continuations.get(eventId);
  if (direct) return direct;
  for (const continuation of node.continuations.values()) {
    const found = findContinuationOwner(continuation.projection, eventId);
    if (found) return found;
  }
  return undefined;
};

/**
 * Pick the node an agent OUTPUT chunk folds into. When the agent echoed the
 * triggering input's `event-id` (`meta.inputEventId`) and it names an existing
 * continuation, the output is a follow-up belonging to that continuation;
 * otherwise (the original run's own outputs, whose echoed id names no
 * continuation) it folds into `base`.
 * @param base - The run's root projection.
 * @param triggeringEventId - The output's echoed `input-event-id` (`meta.inputEventId`), or undefined.
 * @returns The node the output's fold should target.
 */
export const routeOutput = (base: VercelProjection, triggeringEventId: string | undefined): VercelProjection => {
  if (triggeringEventId === undefined) return base;
  return findContinuation(base, triggeringEventId) ?? base;
};

/**
 * Whether `eventId` keys a continuation at or below `node` (used to steer a
 * selector-directed pick toward the branch containing the leaf it names).
 * @param node - The node to search from.
 * @param eventId - The continuation key sought.
 * @returns True when the key exists in this subtree.
 */
const subtreeHasContinuation = (node: VercelProjection, eventId: string): boolean =>
  findContinuation(node, eventId) !== undefined || node.continuations.has(eventId);

/**
 * Choose which continuation to descend into at `node`. With a selector naming a
 * `continuationEventId`, pick the child whose subtree contains (or equals) that
 * key — so the walk homes in on the named leaf. Without a selector, apply the
 * canonical pick: the earliest continuation by seeding serial (first-stable, so
 * a later-arriving sibling never displaces an already-shown branch).
 * @param node - The branching node.
 * @param selector - Optional scope directing the pick.
 * @returns The chosen continuation, or `undefined` when none matches (descent stops).
 */
const choosePick = (node: VercelProjection, selector: MessageSelector | undefined): Continuation | undefined => {
  const target = selector?.continuationEventId;
  if (target !== undefined) {
    for (const [key, continuation] of node.continuations) {
      if (key === target || subtreeHasContinuation(continuation.projection, target)) return continuation;
    }
    return undefined;
  }
  // Canonical pick: earliest by seeding serial. Ably serials are totally
  // ordered and compare lexicographically.
  let best: Continuation | undefined;
  for (const continuation of node.continuations.values()) {
    if (best === undefined || continuation.seedSerial < best.seedSerial) best = continuation;
  }
  return best;
};

/**
 * Materialise the visible message list from a projection, descending through
 * continuations. At each branching node the chosen continuation's messages
 * REPLACE the node's unresolved tail assistant (the continuation's first
 * message is that assistant's resolved copy) and extend it with the follow-up;
 * a node with no continuations (or whose selector points nowhere here) yields
 * its own messages verbatim.
 * @param node - The projection node to materialise.
 * @param selector - Optional scope selecting which branch to follow.
 * @returns The visible messages, root→leaf, each paired with its codec-message-id.
 */
export const materialize = (
  node: VercelProjection,
  selector: MessageSelector | undefined,
): VercelProjection['messages'] => {
  if (node.continuations.size === 0) return node.messages;
  const pick = choosePick(node, selector);
  if (!pick) return node.messages;
  const childMessages = materialize(pick.projection, selector);
  // The child's first message is the resolved copy of this node's tail
  // assistant; it supersedes the unresolved tail, and the rest append.
  return [...node.messages.slice(0, -1), ...childMessages];
};
