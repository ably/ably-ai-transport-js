/**
 * Turns an agent writes, and what the channel carries for them, for the chat
 * transport's suites. The channel itself is `test/helper/read-channel.ts`.
 */

import type * as AI from 'ai';

import { createVercelCodec } from '../../../src/vercel/codec/index.js';
import type { VercelEvent } from '../../../src/vercel/index.js';
import { type ChannelWire, channelWireAcross, channelWireOf } from '../../helper/wire.js';

/**
 * A turn as the agent writes it: `start`, one text part streamed in
 * `deltas`, and a terminal chunk.
 * @param id - The text part's id.
 * @param deltas - The text, as the deltas that stream it.
 * @param end - The terminal chunk.
 * @returns The turn's chunks.
 */
export const textTurn = (
  id: string,
  deltas: string[],
  end: 'finish' | 'abort' | 'error' = 'finish',
): AI.UIMessageChunk[] => [
  { type: 'start' },
  { type: 'text-start', id },
  ...deltas.map((delta): AI.UIMessageChunk => ({ type: 'text-delta', id, delta })),
  { type: 'text-end', id },
  end === 'error' ? { type: 'error', errorText: 'the model failed' } : { type: end },
];

/**
 * A turn whose model failed mid-text, as `toUIMessageStream` writes it: the
 * `error` chunk, then the `finish-step` and `finish` it writes after one.
 * @param id - The text part's id.
 * @param delta - The text streamed before the failure.
 * @returns The turn's chunks.
 */
export const failedTurn = (id: string, delta: string): AI.UIMessageChunk[] => [
  { type: 'start' },
  { type: 'text-start', id },
  { type: 'text-delta', id, delta },
  { type: 'error', errorText: 'the model failed' },
  { type: 'finish-step' },
  { type: 'finish' },
];

/** What an agent that failed before it streamed anything publishes. */
export const failedToStart: AI.UIMessageChunk = { type: 'error', errorText: 'the agent failed to start' };

/**
 * The wire for a run of events written with `pipe` or `send`, encoded with
 * the Vercel codec, with serials that sort in publish order.
 * @param events - The events, in order: an agent's chunks, or a prompt.
 * @returns What history stores and what live delivery carries.
 */
export const wireOf = (events: VercelEvent[]): ChannelWire => channelWireOf(createVercelCodec(), events);

/**
 * The wire for events written before and after a subscriber attached: what
 * history holds for those before, and what live delivery carries for those
 * after, numbered as one run.
 * @param before - The events already on the channel.
 * @param after - The events written once the subscriber is live.
 * @returns History for `before`, live delivery for `after`.
 */
export const wireAcross = (before: VercelEvent[], after: VercelEvent[]): ChannelWire =>
  channelWireAcross(createVercelCodec(), before, after);
