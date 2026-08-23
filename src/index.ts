// Core transport
export type {
  AgentRunTransport,
  AgentTransport,
  AgentTransportOptions,
  CancelRequest,
  ClientTransport,
  ClientTransportOptions,
  DeliverEventResult,
  InvocationData,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  PipeSource,
  PublishInputOptions,
  PublishInputResult,
  ReceiveTransport,
  RunEndParams,
  RunEndReason,
  RunIdentity,
  RunLifecycleEvent,
  RunStatus,
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
  Invocation,
} from './core/transport/index.js';

// Channel resolution for a caller-owned channel: the SDK's channel agent
// param and the mode-set union, for an application that resolves its own
// channel with `client.channels.get(name, options)`.
export { channelAgent } from './core/agent.js';
export { OBJECT_MODES, resolveChannelModes } from './core/channel-options.js';

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
  DecoderCoreOptions,
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
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
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
