// Anthropic Messages: an agent adaptor and a decoder over its codec
export { anthropicAdaptor } from './adaptor.js';
export type { AnthropicErrorEvent, AnthropicEvent, AnthropicInput, AnthropicStreamEvent } from './codec/events.js';
export { anthropicDecoder } from './decoder.js';
