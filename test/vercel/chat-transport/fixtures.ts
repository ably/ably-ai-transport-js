/**
 * Turns an agent writes, and the channel a chat transport reads them from, for
 * the chat transport's suites.
 */

import type * as Ably from '@ably/pubsub-core';
import type * as AI from 'ai';
import { type Mock, vi } from 'vitest';

import { ENDS_FIELD, readOwnExtras, withOwnField } from '../../../src/core/wire.js';
import { createVercelCodec } from '../../../src/vercel/codec/index.js';
import type { VercelEvent } from '../../../src/vercel/index.js';
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
  const stamped: Ably.Message = typeof ends === 'string' ? withOwnField(message, ENDS_FIELD, sortable(ends)) : message;
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

/**
 * The channel a chat transport is handed, as a test drives and asserts on it:
 * the operations the transport reads it through, and `publish`, which it
 * never calls.
 */
export interface ChatChannel {
  /** The channel's name. */
  name: string;
  /** The channel's state, INITIALIZED until something attaches it. */
  state: Ably.ChannelState;
  /** Captures the listener into {@link ChatChannel.listener}. */
  subscribe: Mock<(listener: (message: Ably.InboundMessage) => void) => Promise<null>>;
  /** Clears {@link ChatChannel.listener} when called with the captured listener. */
  unsubscribe: Mock<(listener: (message: Ably.InboundMessage) => void) => void>;
  /** Takes the channel to ATTACHED, with `resumed: false` as on a fresh attach, unless it is attached already. */
  attach: Mock<() => Promise<null>>;
  /** Takes an attached channel to DETACHING at once, and to DETACHED once the detach completes. */
  detach: Mock<() => Promise<void>>;
  /** Resolves with the history pages the channel was built with. */
  history: Mock<(params?: Ably.RealtimeHistoryParams) => Promise<Ably.PaginatedResult<Ably.InboundMessage>>>;
  /** Records a publish, which the chat transport never makes. */
  publish: Mock<(message: Ably.Message) => Promise<Ably.PublishResult>>;
  /** Adds a state listener. */
  on: Mock<(listener: Ably.channelEventCallback) => void>;
  /** Removes a state listener. */
  off: Mock<(listener: Ably.channelEventCallback) => void>;
  /** The listener `subscribe` captured, or `undefined` once unsubscribed. */
  listener?: (message: Ably.InboundMessage) => void;
  /**
   * Deliver a state change to every state listener, as the channel would.
   * @param stateChange - The state change.
   */
  emitStateChange: (stateChange: Ably.ChannelStateChange) => void;
}

/**
 * Serve history pages as Ably's paginated results do.
 * @param pages - The pages, newest first, each newest first within itself.
 * @returns The first page.
 */
export const paginated = (pages: Ably.InboundMessage[][]): Ably.PaginatedResult<Ably.InboundMessage> => {
  const page = (index: number): Ably.PaginatedResult<Ably.InboundMessage> =>
    // CAST: the chat transport reads only `items`, `hasNext()` and `next()`.
    ({
      items: pages[index] ?? [],
      hasNext: () => index + 1 < pages.length,
      // eslint-disable-next-line @typescript-eslint/require-await, unicorn/no-null -- mock returns a resolved promise, and ably-js resolves null past the last page
      next: async () => (index + 1 < pages.length ? page(index + 1) : null),
    }) as unknown as Ably.PaginatedResult<Ably.InboundMessage>;
  return page(0);
};

/**
 * Move a mock channel to a state, emitting the state change as ably-js
 * does.
 * @param channel - The channel.
 * @param current - The state it moves to.
 */
const moveTo = (channel: ChatChannel, current: Ably.ChannelState): void => {
  const previous = channel.state;
  channel.state = current;
  channel.emitStateChange({ current, previous, resumed: false });
};

/**
 * Build the channel a chat transport is handed, serving `pages` as its
 * history.
 * @param pages - The history pages, newest first.
 * @returns The mock, cast to the channel the transport takes.
 */
const createChatChannel = (pages: Ably.InboundMessage[][]): ChatChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const channel: ChatChannel = {
    name: 'chat',
    state: 'initialized',
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    subscribe: vi.fn(async (listener: (message: Ably.InboundMessage) => void): Promise<null> => {
      channel.listener = listener;
      // eslint-disable-next-line unicorn/no-null -- ably-js resolves subscribe with null when the attach changed nothing
      return null;
    }),
    unsubscribe: vi.fn((listener: (message: Ably.InboundMessage) => void): void => {
      if (channel.listener === listener) channel.listener = undefined;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    attach: vi.fn(async (): Promise<null> => {
      if (channel.state !== 'attached') moveTo(channel, 'attached');
      // eslint-disable-next-line unicorn/no-null -- ably-js resolves attach with null when it changed nothing
      return null;
    }),
    detach: vi.fn(async (): Promise<void> => {
      if (channel.state !== 'attached') return;
      moveTo(channel, 'detaching');
      await Promise.resolve();
      moveTo(channel, 'detached');
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    history: vi.fn(async (): Promise<Ably.PaginatedResult<Ably.InboundMessage>> => paginated(pages)),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    publish: vi.fn(async (): Promise<Ably.PublishResult> => ({ serials: [] })),
    on: vi.fn((listener: Ably.channelEventCallback): void => {
      stateListeners.add(listener);
    }),
    off: vi.fn((listener: Ably.channelEventCallback): void => {
      stateListeners.delete(listener);
    }),
    emitStateChange: (stateChange: Ably.ChannelStateChange): void => {
      for (const listener of stateListeners) listener(stateChange);
    },
  };
  // CAST: the chat transport uses only the members above.
  return channel as unknown as ChatChannel & Ably.RealtimeChannel;
};

/** A mock channel, with the run already on it served as history. */
export interface ChannelFixture {
  /** The mock channel. */
  channel: ChatChannel & Ably.RealtimeChannel;
  /**
   * Deliver messages to the subscribed listener, as the channel would live.
   * @param messages - The messages, in order.
   */
  deliver: (messages: Ably.InboundMessage[]) => void;
}

/**
 * A mock channel whose history holds `stored`, newest first as Ably serves
 * it, on pages of `pageSize` messages.
 * @param stored - What history holds, oldest first.
 * @param pageSize - How many messages a page holds; one page holds them all by default.
 * @returns The fixture.
 */
export const channelWith = (stored: Ably.InboundMessage[] = [], pageSize = Infinity): ChannelFixture => {
  const newestFirst = stored.toReversed();
  const pages: Ably.InboundMessage[][] = [];
  for (let start = 0; start < newestFirst.length; start += pageSize) {
    pages.push(newestFirst.slice(start, start + pageSize));
  }
  const channel = createChatChannel(pages);
  return {
    channel,
    deliver: (messages) => {
      for (const message of messages) channel.listener?.(message);
    },
  };
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
