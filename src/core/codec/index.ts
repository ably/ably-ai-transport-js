export type {
  ChannelWriter,
  DecodedMessage,
  Decoder,
  Encoder,
  EncoderOptions,
  Extras,
  MessagePayload,
  StreamPayload,
  StreamSequenceState,
  WireCodec,
  WriteOptions,
} from './types.js';

// Encoder core
export type { EncoderCore, EncoderCoreOptions } from './encoder.js';
export { createEncoderCore } from './encoder.js';

// Decoder core
export type { DecoderCore, DecoderCoreHooks } from './decoder.js';
export { createDecoderCore } from './decoder.js';

// Lifecycle tracker
export type { LifecycleTracker, PhaseConfig } from './lifecycle-tracker.js';
export { createLifecycleTracker } from './lifecycle-tracker.js';

// Typed header-field bindings
export type { DataCodec, FieldFor, HeaderField } from './fields.js';
export { boolField, enumField, jsonField, strField } from './fields.js';

// Output descriptor authoring surface
export type {
  DeltaDecodeContext,
  EndDecodeContext,
  EscapeHatchCore,
  HeaderBuilder,
  OutputDecodeContext,
  OutputDescriptor,
  OutputEncodeHatchContext,
  OutputEventSpec,
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
  DefineCodecConfig,
  InputBuilder,
  LifecycleDiscreteContext,
  LifecyclePolicy,
  OutputBuilder,
} from './define-codec.js';
export { defineCodec } from './define-codec.js';
