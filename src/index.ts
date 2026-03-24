// Core transport
export type {
  ActiveTurn,
  AddMessageOptions,
  CancelFilter,
  CancelRequest,
  ClientTransport,
  ClientTransportOptions,
  CloseOptions,
  ConversationNode,
  ConversationTree,
  LoadHistoryOptions,
  MessageWithHeaders,
  NewTurnOptions,
  PaginatedMessages,
  SendOptions,
  ServerTransport,
  ServerTransportOptions,
  StreamResponseOptions,
  StreamResult,
  Turn,
  TurnEndReason,
  TurnLifecycleEvent,
} from './core/transport/index.js';
export { buildTransportHeaders, createClientTransport, createServerTransport } from './core/transport/index.js';

// Core codec
export type {
  ChannelWriter,
  Codec,
  DecoderCore,
  DecoderCoreHooks,
  DecoderCoreOptions,
  DecoderOutput,
  DiscreteEncoder,
  EncoderCore,
  EncoderCoreOptions,
  EncoderOptions,
  Extras,
  LifecycleTracker,
  MessageAccumulator,
  MessagePayload,
  PhaseConfig,
  StreamDecoder,
  StreamEncoder,
  StreamPayload,
  StreamTrackerState,
  WriteOptions,
} from './core/codec/index.js';
export { createDecoderCore, createEncoderCore, createLifecycleTracker, eventOutput } from './core/codec/index.js';

// Constants
export {
  DOMAIN_HEADER_PREFIX,
  EVENT_ABORT,
  EVENT_CANCEL,
  EVENT_ERROR,
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_TURN_ID,
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from './constants.js';

// Utilities
export type { DomainHeaderReader, DomainHeaderWriter, Stripped } from './utils.js';
export { getHeaders, headerReader, headerWriter, mergeHeaders, stripUndefined } from './utils.js';

// Event emitter
export { EventEmitter } from './event-emitter.js';

// Errors
export { ErrorCode, errorInfoIs } from './errors.js';

// Logger
export type { LogContext, Logger, LoggerOptions, LogHandler } from './logger.js';
export { consoleLogger, LogLevel, makeLogger } from './logger.js';
