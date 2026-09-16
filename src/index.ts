// The transport
export type {
  ChannelWriter,
  HistoryOptions,
  HistoryPage,
  MessageHeaders,
  PipeOptions,
  PipeResult,
  PipeSource,
  SendOptions,
  SendResult,
  Transport,
  TransportOptions,
} from './core/transport/index.js';
export { createTransport } from './core/transport/index.js';

// The extra channel modes a transport can request, as its `channelModes`.
export { OBJECT_MODES } from './core/channel-options.js';

// Codec contract and builder
export type {
  Codec,
  DecodedRow,
  DecoderCore,
  DecoderCoreOptions,
  DefineCodecConfig,
  Delivery,
  EncodedMessage,
  EncodedRow,
  EventRow,
  EventRows,
  HeaderPrimitive,
  RowEvent,
  RowEventType,
  RowMessage,
} from './core/codec/index.js';
export { createDecoderCore, defineCodec } from './core/codec/index.js';

// Utilities
export type { Stripped } from './utils.js';
export { stripUndefined } from './utils.js';

// Event emitter
export { EventEmitter } from './event-emitter.js';

// Errors
export { ErrorCode, errorInfoIs } from './errors.js';

// Logger
export type { LogContext, Logger, LoggerOptions, LogHandler } from './logger.js';
export { consoleLogger, LogLevel, makeLogger } from './logger.js';
