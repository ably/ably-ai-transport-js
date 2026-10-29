// The agent adaptor
export type {
  AgentAdaptor,
  AgentAdaptorOptions,
  ChannelWriter,
  MessageHeaders,
  PipeOptions,
  PipeResult,
  PipeSource,
  Published,
  SendOptions,
  SendResult,
} from './core/adaptor/index.js';
export { createAgentAdaptor } from './core/adaptor/index.js';

// Codec contract and builder
export type {
  Codec,
  DecodedRow,
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
export { defineCodec } from './core/codec/index.js';

// The decoder
export type { Decoder, DecoderOptions } from './core/decoder/index.js';
export { createDecoder } from './core/decoder/index.js';

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
