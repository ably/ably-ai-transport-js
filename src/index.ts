// Core transport
export type {
  AgentRun,
  AgentSession,
  AgentSessionOptions,
  BaseRun,
  BranchHandle,
  CancelRequest,
  ClientRun,
  ClientSession,
  ClientSessionOptions,
  ClientView,
  ConversationNode,
  InputNode,
  InvocationData,
  OutputEvent,
  PipeOptions,
  RunEndParams,
  RunEndReason,
  RunInfo,
  RunLifecycleEvent,
  RunNode,
  RunNodeState,
  RunRuntime,
  RunStatus,
  RunStep,
  SendOptions,
  StepEndParams,
  StepEndReason,
  StepInfo,
  StepOptions,
  StreamResult,
  Tree,
  View,
} from './core/transport/index.js';
export { buildTransportHeaders, createAgentSession, createClientSession, Invocation } from './core/transport/index.js';

// Channel modes
export { OBJECT_MODES } from './core/channel-options.js';

// Core codec
export type {
  BatchAssembleContext,
  BatchMessageHeaders,
  BatchSpec,
  ChannelWriter,
  Codec,
  CodecEvent,
  CodecInputEvent,
  CodecMessage,
  CodecOutputEvent,
  CodecReducer,
  DataCodec,
  DecodedMessage,
  Decoder,
  DecoderCore,
  DecoderCoreHooks,
  DecoderCoreOptions,
  DefineCodecConfig,
  DefinedCodec,
  Encoder,
  EncoderCore,
  EncoderCoreOptions,
  EncoderOptions,
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
  OutputStreamEndContext,
  OutputStreamSpec,
  PartBuilder,
  PartSpec,
  PhaseConfig,
  Reducer,
  ReducerMeta,
  Regenerate,
  StreamPayload,
  StreamTrackerState,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
  WellKnownInputFactories,
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
