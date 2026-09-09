// Core transport
export type {
  DeliverEventResult,
  PipeSource,
  ReceiveTransport,
  StreamResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
  TransportReceiver,
  WireMeta,
} from './core/transport/index.js';
export { createReceiveTransport } from './core/transport/index.js';

// Channel resolution for a caller-owned channel: the SDK's channel agent
// param and the mode-set union, for an application that resolves its own
// channel with `client.channels.get(name, options)`.
export { channelAgent } from './core/agent.js';
export { OBJECT_MODES, resolveChannelModes } from './core/channel-options.js';

// Core codec
export type {
  ChannelWriter,
  DecodedMessage,
  Decoder,
  DecoderCore,
  DecoderCoreHooks,
  Encoder,
  EncoderCore,
  EncoderCoreOptions,
  EncoderOptions,
  Extras,
  MessagePayload,
  StreamPayload,
  StreamSequenceState,
  WireCodec,
  WriteOptions,
} from './core/codec/index.js';
export { createDecoderCore, createEncoderCore } from './core/codec/index.js';

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
