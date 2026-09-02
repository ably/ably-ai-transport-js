/**
 * The channel serial a decoded event rode under.
 *
 * The hydration join is decided on serials alone, so a client needs one
 * reading of "where on the channel did this event come from" that covers both
 * event shapes: a message event carries its wire serial in `meta`, and a
 * lifecycle event carries its own.
 */

import type { TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import type { OpenAIInput } from './openai-thread';

/**
 * Read an event's channel serial.
 * @param event - The decoded event.
 * @returns The serial, or `undefined` for a locally synthesised event, which has none.
 */
export const serialOf = (event: TransportEvent<OpenAIInput, OpenAIOutput>): string | undefined =>
  event.kind === 'message' ? event.meta.serial : event.event.serial;
