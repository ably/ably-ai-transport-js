// Core transport
export type {
  AdoptRunOptions,
  AgentRunTransport,
  AgentTransport,
  AgentTransportOptions,
  CancelRequest,
  ClientTransport,
  ClientTransportOptions,
  DeliverEventResult,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  PipeSource,
  PublishInputOptions,
  PublishInputResult,
  ReceiveTransport,
  RunEndParams,
  RunEndReason,
  RunLifecycleEvent,
  RunStepTransport,
  SteerOutcome,
  SteerResult,
  StepEndParams,
  StepEndReason,
  StepLifecycleEvent,
  StepOptions,
  StreamResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
  TransportReceiver,
  WireMeta,
} from './core/transport/index.js';
export {
  buildTransportHeaders,
  createAgentTransport,
  createClientTransport,
  createReceiveTransport,
} from './core/transport/index.js';

// Channel modes
export { AIT_BASE_MODES, OBJECT_MODES } from './core/channel-options.js';

// Core codec
export type {
  BatchAssembleContext,
  BatchMessageHeaders,
  BatchSpec,
  ChannelWriter,
  DataCodec,
  DecodedMessage,
  Decoder,
  DecoderCore,
  DecoderCoreHooks,
  DefineCodecConfig,
  DeltaDecodeContext,
  Encoder,
  EncoderCore,
  EncoderCoreOptions,
  EncoderOptions,
  EndDecodeContext,
  EscapeHatchCore,
  Extras,
  FieldFor,
  HeaderBuilder,
  HeaderField,
  InputBuilder,
  InputDescriptor,
  InputEventSpec,
  LifecycleDiscreteContext,
  LifecyclePolicy,
  LifecycleTracker,
  MessagePayload,
  OutputBuilder,
  OutputDecodeContext,
  OutputDescriptor,
  OutputEncodeHatchContext,
  OutputEventSpec,
  OutputStreamSpec,
  PartBuilder,
  PartSpec,
  PhaseConfig,
  StreamPayload,
  StreamSequenceState,
  WireCodec,
  WriteOptions,
} from './core/codec/index.js';
export {
  boolField,
  createDecoderCore,
  createEncoderCore,
  createLifecycleTracker,
  defineCodec,
  enumField,
  jsonField,
  strField,
} from './core/codec/index.js';

// Constants
export {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_INPUT_CLIENT_ID,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
} from './constants.js';

// Utilities
export type { Stripped } from './utils.js';
export { getCodecHeaders, getTransportHeaders, mergeHeaders, stripUndefined } from './utils.js';

// Event emitter
export { EventEmitter } from './event-emitter.js';

// Errors
export { ErrorCode, errorInfoIs } from './errors.js';

// Logger
export type { LogContext, Logger, LoggerOptions, LogHandler } from './logger.js';
export { consoleLogger, LogLevel, makeLogger } from './logger.js';
