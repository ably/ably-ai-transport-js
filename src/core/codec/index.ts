export type {
  ChannelWriter,
  Codec,
  CodecInputEvent,
  CodecMessage,
  CodecOutputEvent,
  DecodedMessage,
  Decoder,
  Encoder,
  EncoderOptions,
  Extras,
  MessagePayload,
  Reducer,
  ReducerMeta,
  Regenerate,
  StreamPayload,
  StreamTrackerState,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
  WriteOptions,
} from './types.js';

// Encoder core
export type { EncoderCore, EncoderCoreOptions } from './encoder.js';
export { createEncoderCore } from './encoder.js';

// Decoder core
export type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from './decoder.js';
export { createDecoderCore } from './decoder.js';

// Lifecycle tracker
export type { LifecycleTracker, PhaseConfig } from './lifecycle-tracker.js';
export { createLifecycleTracker } from './lifecycle-tracker.js';

// Typed header-field bindings
export type { HeaderField } from './fields.js';
export { boolField, enumField, jsonField, strField } from './fields.js';

// Well-known input factories
export type { WellKnownInputFactories } from './well-known-inputs.js';
export { wellKnownInputs } from './well-known-inputs.js';

// Codec composition factory
export type {
  InputBuilder,
  InputDecodeContext,
  InputEncodeContext,
  InputEncoderCore,
  LifecyclePolicy,
  OutputBuilder,
} from './define-codec.js';
export { defineCodec } from './define-codec.js';
