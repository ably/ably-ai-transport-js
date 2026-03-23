export { eventOutput } from './decoder.js';
export type {
  ChannelWriter,
  Codec,
  DecoderOutput,
  DiscreteEncoder,
  EncoderOptions,
  Extras,
  MessageAccumulator,
  MessagePayload,
  StreamDecoder,
  StreamEncoder,
  StreamPayload,
  StreamTrackerState,
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
