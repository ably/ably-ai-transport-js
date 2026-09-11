// The codec contract
export type { Codec, Delivery, EncodedMessage } from './codec.js';

// Decoder core, for a hand-written codec that wants the same per-serial
// reduction the builder applies.
export type { DecoderCore, DecoderCoreOptions } from './decoder.js';
export { createDecoderCore } from './decoder.js';

// The builder
export type {
  DecodedRow,
  DefineCodecConfig,
  EncodedRow,
  EventRow,
  EventRows,
  RowEvent,
  RowEventType,
  RowMessage,
} from './define-codec.js';
export { defineCodec } from './define-codec.js';
