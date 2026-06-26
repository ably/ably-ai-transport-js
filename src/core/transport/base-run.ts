/**
 * The shared run read-model implementation.
 *
 * `createBaseRun` derives the {@link BaseRun} contract — `runId`, `status`,
 * `error`, and the whole-turn `messages` — live off the conversation Tree,
 * keyed by the run's id. Because every session holds a Tree, this one
 * implementation can back both sides' runs: a side composes its live getters
 * onto its own run object (e.g. delegating each base getter to it, as the
 * agent's run does) and adds its own side-specific verbs. The getters must be
 * forwarded live, not snapshotted, so `messages`/`status` stay current.
 *
 * It owns no state and starts no I/O — every read reflects whatever is
 * currently folded into the Tree the deps expose.
 */

import type * as Ably from 'ably';

import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import type { BaseRun } from './types/run.js';
import type { RunStatus } from './types/shared.js';
import type { Tree } from './types/tree.js';

/**
 * Dependencies for {@link createBaseRun}, injected by each session per run.
 *
 * The Tree is read through an accessor, not captured: the agent swaps its Tree
 * on channel continuity loss and reads must observe the swap.
 */
export interface BaseRunOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The run's current id. Empty string while the run is not yet known (client, pre run-start). */
  getRunId: () => string;
  /**
   * The codec-message-id of this run's structural triggering input (the input
   * node whose reply this run is). `undefined` when the run has no triggering
   * input node — a no-input run, or a wire-only continuation/regenerate carrier
   * that introduced no input message; such runs contribute output only.
   */
  getInputAnchor: () => string | undefined;
  /** Live accessor for the session's current materialisation Tree. */
  getTree: () => Tree<TOutput, TProjection>;
  /** Codec used to project per-node messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
}

/**
 * Build the shared {@link BaseRun} read members (`runId`, `status`, `error`,
 * `messages`) over the Tree. Returns an object of live getter accessors — a
 * side composes it onto its own run object, forwarding the getters live (e.g.
 * delegating each one, or copying the property descriptors) so reads stay
 * current rather than snapshotting at compose time.
 * @param options - The injected per-run dependencies.
 * @returns The shared run read-model.
 */
export const createBaseRun = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  options: BaseRunOptions<TInput, TOutput, TProjection, TMessage>,
): BaseRun<TMessage> => {
  const { getRunId, getInputAnchor, getTree, codec } = options;

  return {
    get runId(): string {
      return getRunId();
    },

    get status(): RunStatus {
      // No node yet (a freshly-created run whose run-start has not folded in)
      // reads as 'active' — the run is in flight, just not yet observed.
      return getTree().getRunNode(getRunId())?.state.status ?? 'active';
    },

    get error(): Ably.ErrorInfo | undefined {
      const state = getTree().getRunNode(getRunId())?.state;
      return state?.status === 'error' ? state.error : undefined;
    },

    get messages(): TMessage[] {
      const tree = getTree();
      const seen = new Set<string>();
      const out: TMessage[] = [];

      const append = (projection: TProjection): void => {
        for (const m of codec.getMessages(projection)) {
          if (seen.has(m.codecMessageId)) continue;
          seen.add(m.codecMessageId);
          out.push(m.message);
        }
      };

      // The triggering input's own message(s), when this run introduced an
      // input node. A wire-only carrier (regenerate signal, tool resolution)
      // has no input node — or resolves to a prior run node — so it is skipped
      // and the turn is output-only.
      const anchor = getInputAnchor();
      const inputNode = anchor === undefined ? undefined : tree.getNodeByCodecMessageId(anchor);
      if (inputNode?.kind === 'input') append(inputNode.projection);

      // This run's own streamed output. Deduped against the input above so a
      // continuation whose input node is its run node is not double-counted.
      const runNode = tree.getRunNode(getRunId());
      if (runNode !== undefined) append(runNode.projection);

      return out;
    },
  };
};
