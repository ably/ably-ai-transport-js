/**
 * The check the adaptor makes on every message a codec encodes: that it
 * carries the codec's `name` as its message name and the codec's `id` under
 * `extras.ai.codec`, as the codec contract requires. A decoder over the codec
 * skips any message without both, so a codec that leaves either out would
 * publish messages its own readers never decode, with nothing to say why.
 * `defineCodec` always writes both; the check is for a hand-written codec.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Codec } from '../codec/codec.js';
import { CODEC_FIELD, readOwnExtras } from '../wire.js';

/**
 * Throw unless a message carries its codec's name and id.
 * @param message - A message the codec encoded.
 * @param codec - The codec that encoded it.
 * @param operation - The call, for the error message.
 * @throws {Ably.ErrorInfo} `InvalidArgument` naming what the message carries and what the codec expects.
 */
export const assertCodecWrote = (
  message: Ably.Message,
  codec: Pick<Codec<unknown>, 'id' | 'name'>,
  operation: 'send' | 'pipe',
): void => {
  const written = readOwnExtras(message.extras)?.[CODEC_FIELD];
  if (message.name === codec.name && written === codec.id) return;
  throw new Ably.ErrorInfo(
    `unable to ${operation}; codec '${codec.id}' encoded a message named '${String(message.name)}' with codec id '${String(written)}', and its decoder only reads messages named '${codec.name}' with codec id '${codec.id}'`,
    ErrorCode.InvalidArgument,
    400,
  );
};
