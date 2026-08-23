// Core transport
export type {
  AdoptedRun,
  AgentRun,
  AgentRunTransport,
  AgentSession,
  AgentSessionContext,
  AgentSessionOptions,
  AgentTransport,
  AgentTransportOptions,
  BaseRun,
  BranchHandle,
  CancelRequest,
  ClientRun,
  ClientSession,
  ClientSessionOptions,
  ClientTransport,
  ClientTransportOptions,
  ClientView,
  ConversationNode,
  DeliverEventResult,
  InputNode,
  InvocationData,
  LocatedInput,
  OpenableRun,
  OpenRunHooks,
  OpenRunOptions,
  OutputEvent,
  PipeSource,
  PublishInputOptions,
  PublishInputResult,
  ReceiveTransport,
  RunEndParams,
  RunEndReason,
  RunIdentity,
  RunInfo,
  RunLifecycleEvent,
  RunNode,
  RunNodeState,
  RunStatus,
  RunStep,
  RunStepTransport,
  SendOptions,
  SteerOutcome,
  SteerResult,
  StepEndParams,
  StepEndReason,
  StepInfo,
  StepLifecycleEvent,
  StepOptions,
  StreamResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
  TransportReceiver,
  Tree,
  View,
  WireMeta,
  WithAgentSessionOptions,
} from './core/transport/index.js';
export type { LocatableRun, PageUntilLocatedOptions } from './core/transport/index.js';
export {
  buildTransportHeaders,
  createAgentSession,
  createAgentTransport,
  createClientSession,
  createClientTransport,
  createReceiveTransport,
  Invocation,
  pageUntilLocated,
  withAgentSession,
} from './core/transport/index.js';

// Channel modes
export { OBJECT_MODES } from './core/channel-options.js';

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
