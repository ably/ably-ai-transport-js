// Vercel AI SDK codec
export { UIMessageCodec } from './codec/index.js';

// Vercel AI SDK transport wrappers (pre-bound to UIMessageCodec)
export type {
  ChatTransport,
  ChatTransportOptions,
  SendMessagesRequestContext,
  VercelClientTransportOptions,
  VercelServerTransportOptions,
} from './transport/index.js';
export { createChatTransport, createClientTransport, createServerTransport } from './transport/index.js';

// Server-side tool result merge helper
export { applyToolEventsToHistory } from './tool-events.js';
