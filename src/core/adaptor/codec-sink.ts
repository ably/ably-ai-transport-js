/**
 * Codec sink — the event sink of the codec's wire format.
 *
 * It encodes each event through the codec, checks that every message carries
 * the codec's `name` and `id`, adds the writer's headers, and writes the
 * messages through a pipe writer, whose key table maps the codec's stream
 * keys onto message streams and stamps the markers a decoder reads. All of
 * that is the codec's wire format; the event writer that writes into this
 * sink knows none of it.
 */

import type { Codec } from '../codec/codec.js';
import { assertCodecWrote } from './codec-fields.js';
import type { EventSink, SinkOutcome } from './event-writer.js';
import { type MessageHeaders, withHeaders } from './headers.js';
import type { PipeWriter } from './pipe-writer.js';

/**
 * Create the sink that writes a codec's events through a pipe writer.
 * @param codec - The codec.
 * @param writer - The pipe writer, holding the key table.
 * @param headers - The headers added to every message before it reaches the pipe writer, so a repair carries them too. Already checked by the caller.
 * @returns The sink.
 */
export const createCodecSink = <E>(codec: Codec<E>, writer: PipeWriter, headers?: MessageHeaders): EventSink<E> => ({
  prepare: (event, operation) => {
    const encoded = codec.encode(event);
    for (const { message } of encoded) assertCodecWrote(message, codec, operation);
    const messages =
      headers === undefined ? encoded : encoded.map((m) => ({ ...m, message: withHeaders(m.message, headers) }));
    return {
      reserve: () => {
        writer.reserve(messages);
      },
      write: async (): Promise<SinkOutcome> => {
        let serial: string | undefined;
        let publishedSerial: string | undefined;
        for (const message of messages) {
          try {
            const result = await writer.write(message);
            serial = result.serial;
            if (result.published) publishedSerial = result.serial;
          } catch (error) {
            return { ok: false, failed: message.update === undefined ? 'publish' : 'update', error };
          }
        }
        return { ok: true, serial, publishedSerial };
      },
    };
  },
  flush: async () => writer.flush(),
  handoff: () => ({ streams: writer.openStreams() }),
  abort: () => {
    writer.abort();
  },
});
