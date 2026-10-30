/**
 * Turns an agent writes, and the channel a chat transport reads them from, for
 * the chat transport's suites.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

import { ENDS_FIELD, readOwnExtras, withOwnField } from '../../../src/core/wire.js';
import { createVercelCodec, type VercelEvent } from '../../../src/vercel/index.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createMockClient, type MockClient } from '../../helper/mock-client.js';
import { deliveriesOf, encodeAll, historyOf } from '../../helper/wire.js';

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
 * The fixture wire names serials `s1`, `s2`… and version serials `s1:v1`,
 * `s1:v2`…; Ably's serials sort in publish order, so pad each number to a
 * fixed width to sort these the same way.
 * @param serial - A fixture serial or version serial.
 * @returns The same serial, padded.
 */
const sortable = (serial: string): string => serial.replaceAll(/\d+/g, (n) => n.padStart(4, '0'));

/**
 * A fixture message with every serial it carries made sortable: its own, its
 * version's, and the one a closer names under `extras.ai.ends`.
 * @param message - The fixture message.
 * @returns The message with sortable serials.
 */
const withSortableSerials = (message: Ably.InboundMessage): Ably.InboundMessage => {
  const ends = readOwnExtras(message.extras)?.[ENDS_FIELD];
  const stamped = typeof ends === 'string' ? withOwnField(message, ENDS_FIELD, sortable(ends)) : message;
  // CAST: the stamped copy keeps every field of the inbound message it was made from.
  return {
    ...stamped,
    serial: sortable(message.serial ?? ''),
    version: { ...message.version, serial: sortable(message.version.serial ?? '') },
  } as Ably.InboundMessage;
};

/** One run of chunks on the channel: what history stores and what a live subscriber receives. */
export interface ChannelWire {
  /** What history holds for the run, oldest first: one stored message per serial, appends joined. */
  stored: Ably.InboundMessage[];
  /** What a live subscriber receives for the run, in order: a create per message, then its appends. */
  live: Ably.InboundMessage[];
}

/**
 * The wire for a run of events written with `pipe` or `send`, encoded with
 * the Vercel codec, with serials that sort in publish order.
 * @param events - The events, in order: an agent's chunks, or a prompt.
 * @returns What history stores and what live delivery carries.
 */
export const wireOf = (events: VercelEvent[]): ChannelWire => {
  const encoded = encodeAll(createVercelCodec(), events);
  return {
    stored: historyOf(encoded).map((message) => withSortableSerials(message)),
    live: deliveriesOf(encoded).map((message) => withSortableSerials(message)),
  };
};

/** A mock channel and the client it is resolved from, with the run already on the channel served as history. */
export interface ChannelFixture {
  /** The mock channel. */
  channel: MockChannel & Ably.RealtimeChannel;
  /** The client that hands out the channel. */
  client: MockClient & Ably.Realtime;
  /**
   * Deliver messages to the subscribed listener, as the channel would live.
   * @param messages - The messages, in order.
   */
  deliver: (messages: Ably.InboundMessage[]) => void;
}

/**
 * A mock channel whose history holds `stored`, newest first on one page as
 * Ably serves it, with a client that resolves it.
 * @param stored - What history holds, oldest first.
 * @returns The fixture.
 */
export const channelWith = (stored: Ably.InboundMessage[] = []): ChannelFixture => {
  const channel = createMockChannel(stored.length === 0 ? [] : [stored.toReversed()]);
  return {
    channel,
    client: createMockClient(channel),
    deliver: (messages) => {
      for (const message of messages) channel.listener?.(message);
    },
  };
};

/**
 * Make a mock channel move through its states as ably-js does, from
 * INITIALIZED: `attach()` takes it to ATTACHED, with `resumed: false` as on
 * a fresh attach, and `detach()` takes it to DETACHING at once and to
 * DETACHED once the detach completes. Each move emits its state change.
 * @param channel - The mock channel.
 */
export const movingThroughStates = (channel: MockChannel & Ably.RealtimeChannel): void => {
  const move = (current: Ably.ChannelState): void => {
    const previous = channel.state;
    channel.state = current;
    channel.emitStateChange({ current, previous, resumed: false });
  };
  channel.state = 'initialized';
  channel.attach.mockImplementation(async (): Promise<void> => {
    if (channel.state !== 'attached') move('attached');
    await Promise.resolve();
  });
  channel.detach.mockImplementation(async (): Promise<void> => {
    if (channel.state !== 'attached') return;
    move('detaching');
    await Promise.resolve();
    move('detached');
  });
};

/** A wait a test ends itself. */
export interface Gate {
  /** Resolves once the gate opens. */
  promise: Promise<void>;
  /** Open the gate. */
  open: () => void;
}

/**
 * A wait a test ends itself, such as a detach still in flight.
 * @returns The gate, closed.
 */
export const gate = (): Gate => {
  const opener: { open?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    opener.open = resolve;
  });
  return {
    promise,
    open: () => {
      opener.open?.();
    },
  };
};

/**
 * The wire for events written before and after a subscriber attached: what
 * history holds for those before, and what live delivery carries for those
 * after, numbered as one run.
 * @param before - The events already on the channel.
 * @param after - The events written once the subscriber is live.
 * @returns History for `before`, live delivery for `after`.
 */
export const wireAcross = (before: VercelEvent[], after: VercelEvent[]): ChannelWire => {
  const earlier = wireOf(before);
  return { stored: earlier.stored, live: wireOf([...before, ...after]).live.slice(earlier.live.length) };
};
