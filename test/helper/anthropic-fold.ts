/** Fold decoded Anthropic stream events through the SDK's own reducer. */

import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type * as Anthropic from '@anthropic-ai/sdk/resources/messages';

import type { AnthropicEvent, AnthropicStreamEvent } from '../../src/anthropic/index.js';

/**
 * Fold one message's events with `MessageStream.fromReadableStream`, which
 * reads the newline-delimited JSON the SDK's `toReadableStream()` writes.
 * @param events - One message's events, from its `message_start`.
 * @returns The message the SDK assembles.
 */
const foldOne = async (events: AnthropicStreamEvent[]): Promise<Anthropic.Message> => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });

  return MessageStream.fromReadableStream(stream).finalMessage();
};

/**
 * Fold a stream event sequence through the SDK's reducer and return each
 * message it builds, in order. The reducer folds one message per stream, so a
 * sequence carrying several is split at each `message_start`; the codec's own
 * `input` is left out, since the reducer only takes the API's events. The
 * reducer rejects only a second `message_start` before `message_stop`: it
 * skips a block event that comes before `message_start` and a delta for a
 * block of another type. So a sequence that folds is not proof the SDK
 * accepts it; a test compares the folded messages with the ones it expects.
 * @param events - The events, in wire order.
 * @returns The messages, each as JSON would carry it.
 */
export const foldWithMessageStream = async (events: AnthropicEvent[]): Promise<unknown[]> => {
  const messages: AnthropicStreamEvent[][] = [];

  for (const event of events) {
    if (event.type === 'input') continue;
    if (event.type === 'message_start') messages.push([]);
    messages.at(-1)?.push(event);
  }

  const folded = await Promise.all(messages.map(async (message) => foldOne(message)));

  // The SDK keeps tool input behind a getter and adds non-enumerable fields;
  // JSON gives the message the API sends and a fixture records.
  // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON drops undefined values, as the fixtures do
  return folded.map((message): unknown => JSON.parse(JSON.stringify(message)));
};
