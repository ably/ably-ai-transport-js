/**
 * Session materialisation — the Tree plus its single decode-and-apply engine.
 *
 * Both sessions reconstruct conversation state by folding wire messages into a
 * {@link DefaultTree} through a {@link WireApplier} that binds one codec decoder
 * to that Tree. The pair must be created together — a fresh Tree always needs a
 * fresh decoder so stream-tracker state can't leak across Trees — and the agent
 * recreates the pair on channel continuity loss. This factory is the single
 * construction site so the client constructor, the agent constructor, and the
 * agent's continuity-loss swap can't drift on how the pair is wired.
 */

import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { createWireApplier, type WireApplier } from './decode-fold.js';
import { createTree, type DefaultTree } from './tree.js';

/**
 * A Tree paired with the {@link WireApplier} that folds wire messages into it.
 * The applier binds a decoder unique to this Tree; replace the whole pair (do
 * not reuse an applier) when the Tree is swapped.
 */
export interface Materialisation<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection> {
  /** The conversation Tree — the session's source of truth. */
  tree: DefaultTree<TInput, TOutput, TProjection>;
  /** The Tree's single decode-and-apply engine, binding a fresh codec decoder. */
  applier: WireApplier;
}

/**
 * Create a fresh {@link Materialisation}: a new Tree and a {@link WireApplier}
 * binding a new codec decoder to it.
 * @param codec - The codec whose reducer drives the Tree and whose decoder the applier binds.
 * @param logger - Logger for the Tree, or `undefined` to fall back to a silent logger.
 * @returns The Tree + applier pair.
 */
export const createMaterialisation = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  codec: Codec<TInput, TOutput, TProjection, TMessage>,
  logger: Logger | undefined,
): Materialisation<TInput, TOutput, TProjection> => {
  const tree = createTree<TInput, TOutput, TProjection>(codec, logger ?? makeLogger({ logLevel: LogLevel.Silent }));
  const applier = createWireApplier(tree, codec.createDecoder());
  return { tree, applier };
};
