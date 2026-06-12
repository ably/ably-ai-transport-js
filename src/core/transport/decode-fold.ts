/**
 * Shared wire decode-and-apply engine.
 *
 * The client's live decode loop and the View's history replay both reconstruct
 * the conversation Tree from the same raw Ably wire log. This module is the one
 * place that classifies a wire message (run-lifecycle vs codec-decoded), parses
 * or decodes it, and applies it to the Tree — so the two paths can never drift.
 *
 * The engine is exposed as a {@link WireApplier} binding one Tree to one
 * decoder. A Tree has exactly one applier (the session constructs it and hands
 * it to every View), so every route a wire message can arrive by — the live
 * subscription, View history pagination, the agent's hydration walks — feeds
 * the same decoder. The decoder's version-guarded stream trackers then make
 * re-delivery across routes (an attach-boundary in-flight stream, a replayed
 * history page) decode to nothing instead of double-folding.
 */

import type * as Ably from 'ably';

import { HEADER_RUN_ID } from '../../constants.js';
import { getTransportHeaders } from '../../utils.js';
import type { CodecInputEvent, CodecOutputEvent, Decoder } from '../codec/types.js';
import { isRunLifecycleName, parseRunLifecycle } from './headers.js';
import type { TreeInternal } from './tree.js';
import type { RunLifecycleEvent } from './types.js';

/**
 * The decode-and-apply engine for one Tree: a single codec decoder bound to a
 * single Tree, shared by every route that feeds the Tree wire messages.
 */
export interface WireApplier {
  /**
   * Apply one inbound wire message to the bound tree.
   *
   * Run-lifecycle messages are turned into a {@link RunLifecycleEvent} via
   * {@link parseRunLifecycle} and applied with `applyRunLifecycle`; everything
   * else is decoded with the bound decoder and applied with `applyMessage`,
   * skipping wire-only carriers that decode to no events and carry no run-id
   * (the eventual reply run is created later by its run-start).
   *
   * Does NOT emit the tree's `ably-message` event — the caller owns that,
   * because the live loop emits per message while history replay emits in a
   * batch once the whole page is applied. Returns the parsed lifecycle event
   * so a live caller can run its own side-effects (resolving a pending
   * run-start, surfacing an agent error); returns `undefined` for a
   * codec-decoded message or a lifecycle message that carried no run-id.
   * @param rawMsg - The inbound Ably wire message.
   * @returns The parsed run-lifecycle event, or `undefined`.
   */
  apply(rawMsg: Ably.InboundMessage): RunLifecycleEvent | undefined;
}

/**
 * Classify, decode, and apply one inbound wire message to the tree. See
 * {@link WireApplier.apply} for the contract.
 * @param tree - The tree to apply the message to.
 * @param decoder - The codec decoder used for non-lifecycle messages.
 * @param rawMsg - The inbound Ably wire message.
 * @returns The parsed run-lifecycle event, or `undefined`.
 */
const applyWireMessage = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection>(
  tree: TreeInternal<TInput, TOutput, TProjection>,
  decoder: Decoder<TInput, TOutput>,
  rawMsg: Ably.InboundMessage,
): RunLifecycleEvent | undefined => {
  const headers = getTransportHeaders(rawMsg);
  const serial = rawMsg.serial;
  // Top-level timestamp (the current version's receive time), not
  // `version.timestamp` — see the Tree's event-log retention clock.
  const timestamp = rawMsg.timestamp;

  if (isRunLifecycleName(rawMsg.name)) {
    const event = parseRunLifecycle(rawMsg.name, headers, serial, timestamp);
    if (event) tree.applyRunLifecycle(event);
    return event;
  }

  const { inputs, outputs } = decoder.decode(rawMsg);
  if (inputs.length > 0 || outputs.length > 0 || headers[HEADER_RUN_ID]) {
    tree.applyMessage({ inputs, outputs }, headers, serial, timestamp);
  }
  return undefined;
};

/**
 * Bind a Tree and a decoder into the Tree's single {@link WireApplier}.
 * @param tree - The tree the applier feeds.
 * @param decoder - The codec decoder shared by every route into the tree.
 * @returns The applier.
 */
export const createWireApplier = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection>(
  tree: TreeInternal<TInput, TOutput, TProjection>,
  decoder: Decoder<TInput, TOutput>,
): WireApplier => ({
  apply: (rawMsg: Ably.InboundMessage): RunLifecycleEvent | undefined => applyWireMessage(tree, decoder, rawMsg),
});
