/**
 * AG-UI runs as the developer's agent publishes them, and what a thread's
 * channel carries for them, for the AG-UI agent's suites. The channel itself
 * is `test/helper/read-channel.ts`.
 */

import type * as Ably from '@ably/pubsub-core';
import type * as AGUI from '@ag-ui/core';
import { EventType } from '@ag-ui/core';

import { agui } from '../../../src/ag-ui/codec/index.js';
import { type ChannelWire, channelWireOf } from '../../helper/wire.js';

/** The thread every fixture run belongs to. */
export const THREAD = 'th1';

/**
 * A run that answers in text: `RUN_STARTED`, one text message streamed in
 * `deltas`, and `RUN_FINISHED`.
 * @param runId - The run's id.
 * @param messageId - The text message's id.
 * @param deltas - The text, as the deltas that stream it.
 * @returns The run's events.
 */
export const textRun = (runId: string, messageId: string, deltas: string[]): AGUI.Event[] => [
  { type: EventType.RUN_STARTED, threadId: THREAD, runId },
  { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
  ...deltas.map((delta): AGUI.Event => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })),
  { type: EventType.TEXT_MESSAGE_END, messageId },
  { type: EventType.RUN_FINISHED, threadId: THREAD, runId },
];

/**
 * The wire for events written with `pipe` or `send` through the AG-UI codec,
 * with serials that sort in publish order.
 * @param events - The events, in order.
 * @returns What history stores and what live delivery carries.
 */
export const wireOf = (events: AGUI.Event[]): ChannelWire => channelWireOf(agui, events);

/**
 * A message the application publishes on the thread's channel itself, which
 * no codec wrote.
 * @param serial - Its serial.
 * @returns The message.
 */
export const foreignMessage = (serial: string): Ably.InboundMessage =>
  // CAST: a fixture inbound message with the fields a reader looks at.
  ({
    name: 'cancel',
    data: { runId: 'r1' },
    action: 'message.create',
    serial,
    version: { serial },
  }) as Ably.InboundMessage;
