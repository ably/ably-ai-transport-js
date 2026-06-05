/**
 * Shared wire decode-and-apply engine.
 *
 * The client's live decode loop and the View's history replay both reconstruct
 * the conversation Tree from the same raw Ably wire log. This module is the one
 * place that classifies a wire message (run-lifecycle vs codec-decoded), parses
 * or decodes it, and applies it to the Tree — so the two paths can never drift.
 */

import type * as Ably from 'ably';

import { HEADER_RUN_ID } from '../../constants.js';
import { getTransportHeaders } from '../../utils.js';
import type { CodecInputEvent, CodecOutputEvent, Decoder } from '../codec/types.js';
import { isRunLifecycleName, parseRunLifecycle } from './headers.js';
import type { TreeInternal } from './tree.js';
import type { RunLifecycleEvent } from './types.js';

/**
 * Apply one inbound wire message to the tree.
 *
 * Run-lifecycle messages are turned into a {@link RunLifecycleEvent} via
 * {@link parseRunLifecycle} and applied with `applyRunLifecycle`; everything
 * else is decoded with `decoder` and applied with `applyMessage`, skipping
 * wire-only carriers that decode to no events and carry no run-id (the eventual
 * reply run is created later by its run-start).
 *
 * Does NOT emit the tree's `ably-message` event — the caller owns that, because
 * the live loop emits per message while history replay emits in a batch once
 * the whole page is applied. Returns the parsed lifecycle event so a live
 * caller can run its own side-effects (resolving a pending run-start,
 * surfacing an agent error); returns `undefined` for a codec-decoded message
 * or a lifecycle message that carried no run-id.
 * @param tree - The tree to apply the message to.
 * @param decoder - The codec decoder used for non-lifecycle messages.
 * @param rawMsg - The inbound Ably wire message.
 * @returns The parsed run-lifecycle event, or `undefined`.
 */
export const applyWireMessage = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection>(
  tree: TreeInternal<TInput, TOutput, TProjection>,
  decoder: Decoder<TInput, TOutput>,
  rawMsg: Ably.InboundMessage,
): RunLifecycleEvent | undefined => {
  const headers = getTransportHeaders(rawMsg);
  const serial = rawMsg.serial;

  if (isRunLifecycleName(rawMsg.name)) {
    const event = parseRunLifecycle(rawMsg.name, headers, serial);
    if (event) tree.applyRunLifecycle(event);
    return event;
  }

  const { inputs, outputs } = decoder.decode(rawMsg);
  if (inputs.length > 0 || outputs.length > 0 || headers[HEADER_RUN_ID]) {
    tree.applyMessage({ inputs, outputs }, headers, serial);
  }
  return undefined;
};
