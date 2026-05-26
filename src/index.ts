// Core transport
export type {
  ActiveRun,
  AddMessageOptions,
  AddMessagesResult,
  AgentSession,
  AgentSessionOptions,
  CancelFilter,
  CancelRequest,
  ClientSession,
  ClientSessionOptions,
  CloseOptions,
  EventsNode,
  InvocationData,
  MessageNode,
  PipeOptions,
  Run,
  RunEndReason,
  RunLifecycleEvent,
  RunRuntime,
  RunView,
  SendOptions,
  StreamResult,
  Tree,
  View,
} from './core/transport/index.js';

// Deprecated aliases — intentional re-export of deprecated types for backwards compatibility.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export type { EventNode } from './core/transport/index.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated
export type { TreeNode } from './core/transport/index.js';
export { buildTransportHeaders, createAgentSession, createClientSession, Invocation } from './core/transport/index.js';

// Core codec
export type {
  ChannelWriter,
  Codec,
  Decoder,
  DecoderCore,
  DecoderCoreHooks,
  DecoderCoreOptions,
  Encoder,
  EncoderCore,
  EncoderCoreOptions,
  EncoderOptions,
  Extras,
  LifecycleTracker,
  MessagePayload,
  PhaseConfig,
  Reducer,
  ReducerMeta,
  StreamPayload,
  StreamTrackerState,
  WriteOptions,
} from './core/codec/index.js';
export { createDecoderCore, createEncoderCore, createLifecycleTracker } from './core/codec/index.js';

// Constants
export {
  DOMAIN_HEADER_PREFIX,
  EVENT_ABORT,
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_RUN_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
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
