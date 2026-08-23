/**
 * Session materialisation — the Tree plus the receive transport that folds wire
 * messages into it.
 *
 * Both sessions reconstruct conversation state by folding wire messages into a
 * {@link DefaultTree} through a {@link ReceiveTransport} that binds one codec
 * decoder. The Tree subscribes to the receiver's public `event` and
 * `ably-message` streams exactly as a third-party consumer would — it has no
 * privileged access to the wire. The pair must be created together (a fresh
 * Tree always needs a fresh decoder so stream-tracker state can't leak across
 * Trees), and the agent recreates the pair on channel continuity loss. This
 * factory is the single construction site so the client constructor, the agent
 * constructor, and the agent's continuity-loss swap can't drift on how the pair
 * is wired.
 */

import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { wrapMessageProcessingError } from './channel-support.js';
import { createReceiveTransport, type ReceiveTransport } from './receive-transport.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from './session-codec.js';
import { createTree, type DefaultTree, type TreeInternal } from './tree.js';
import type { TransportEvent } from './types/transport.js';

/**
 * Fold one classified {@link TransportEvent} into a Tree by calling its existing
 * apply methods. A `message` event drives `applyMessage` off the raw transport
 * header bucket carried on the event's `meta.transport`, so the Tree consumes
 * the public event exactly as a third-party subscriber would, with no
 * privileged access to the wire.
 * @param tree - The tree to apply the event to.
 * @param event - The classified transport event.
 */
export const applyTransportEventToTree = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
>(
  tree: TreeInternal<TInput, TOutput, TProjection>,
  event: TransportEvent<TInput, TOutput>,
): void => {
  switch (event.kind) {
    case 'message': {
      const { meta } = event;
      tree.applyMessage(
        { inputs: event.inputs, outputs: event.outputs },
        meta.transport,
        meta.serial,
        meta.timestamp,
        meta.versionSerial,
      );
      break;
    }
    case 'run-lifecycle': {
      tree.applyRunLifecycle(event.event);
      break;
    }
    case 'step-lifecycle': {
      tree.applyStepLifecycle(event.event);
      break;
    }
  }
};

/**
 * A Tree paired with the {@link ReceiveTransport} that folds wire messages into
 * it. The receiver binds a decoder unique to this Tree and the Tree is
 * subscribed to its event streams; replace the whole pair (do not reuse a
 * receiver) when the Tree is swapped.
 */
export interface Materialisation<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection> {
  /** The conversation Tree — the session's source of truth. */
  tree: DefaultTree<TInput, TOutput, TProjection>;
  /** The Tree's receive transport, binding a fresh codec decoder, with the Tree subscribed to its event streams. */
  receiver: ReceiveTransport<TInput, TOutput>;
}

/**
 * Create a fresh {@link Materialisation}: a new Tree and a
 * {@link ReceiveTransport} binding a new codec decoder, with the Tree subscribed
 * to the receiver's `event` (fold) and `ably-message` (notify) streams.
 * @param codec - The codec whose reducer drives the Tree and whose decoder the receiver binds.
 * @param logger - Logger for the Tree and receiver, or `undefined` to fall back to a silent logger.
 * @param reorderWindowMs - The Tree's event-log retention window in ms;
 *   `undefined` falls back to the Tree's default. Threaded from the session so
 *   a continuity-loss tree swap rebuilds with the same window.
 * @returns The Tree + receiver pair.
 */
export const createMaterialisation = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  codec: Codec<TInput, TOutput, TProjection, TMessage>,
  logger: Logger | undefined,
  reorderWindowMs?: number,
): Materialisation<TInput, TOutput, TProjection> => {
  const resolvedLogger = logger ?? makeLogger({ logLevel: LogLevel.Silent });
  const tree = createTree<TInput, TOutput, TProjection>(codec, resolvedLogger, reorderWindowMs);
  const receiver = createReceiveTransport<TInput, TOutput>(codec.createDecoder(), resolvedLogger);
  // The Tree consumes the public event stream like any subscriber: fold each
  // classified event, then forward the raw message on the paired `ably-message`.
  // The receiver guarantees `event` precedes `ably-message`, so a subscriber
  // running after the Tree sees the freshly-folded state and populated indices.
  //
  // The fold is bracketed because the receiver's emitter isolates listener
  // throws (logging them only): without the bracket a Tree fold failure — in
  // practice a codec `fold` throw — would vanish, and the paired `ably-message`
  // would announce a message the Tree never folded. The bracket surfaces the
  // failure on the receiver's `error` stream (which sessions forward to their
  // own `error` event) and records the failed wire's serial so the paired raw
  // emit is suppressed. Matching by serial, rather than a boolean latch, keeps a
  // failed local echo (serial `undefined`, no paired raw message) from
  // suppressing an unrelated wire's `ably-message`.
  let failedSerial: string | undefined;
  receiver.on('event', (event) => {
    try {
      applyTransportEventToTree(tree, event);
    } catch (error) {
      failedSerial = event.kind === 'message' ? event.meta.serial : event.event.serial;
      const err = wrapMessageProcessingError(error);
      resolvedLogger.error('createMaterialisation(); tree fold failed', { serial: failedSerial, code: err.code });
      receiver.emitError(err);
    }
  });
  receiver.on('ably-message', (msg) => {
    if (failedSerial !== undefined && msg.serial === failedSerial) {
      failedSerial = undefined;
      return;
    }
    tree.emitAblyMessage(msg);
  });
  return { tree, receiver };
};
