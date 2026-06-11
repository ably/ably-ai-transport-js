export type {
  ChannelWriter,
  Codec,
  CodecEvent,
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
export type { DataCodec, FieldFor, HeaderField } from './fields.js';
export { boolField, enumField, jsonField, strField } from './fields.js';

// Well-known input factories (merged into every codec by defineCodec)
export type { WellKnownInputFactories } from './well-known-inputs.js';

// Output descriptor authoring surface
export type {
  EscapeHatchCore,
  HeaderBuilder,
  OutputDecodeContext,
  OutputDescriptor,
  OutputEncodeHatchContext,
  OutputEventSpec,
  OutputStreamEndContext,
  OutputStreamSpec,
} from './output-descriptors.js';

// Input descriptor authoring surface
export type {
  BatchAssembleContext,
  BatchMessageHeaders,
  BatchSpec,
  InputDescriptor,
  InputEventSpec,
  PartBuilder,
  PartSpec,
} from './input-descriptors.js';

// Codec composition factory
export type {
  CodecReducer,
  DefineCodecConfig,
  DefinedCodec,
  InputBuilder,
  LifecycleDiscreteContext,
  LifecyclePolicy,
  OutputBuilder,
} from './define-codec.js';
export { defineCodec } from './define-codec.js';
