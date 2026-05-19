// Vercel AI SDK codec
export type { ToolApprovalEvent, UserMessageEvent, VercelEvent, VercelProjection } from './codec/index.js';
export { UIMessageCodec } from './codec/index.js';

// Vercel AI SDK transport wrappers (pre-bound to UIMessageCodec)
export type {
  ChatTransport,
  ChatTransportOptions,
  SendMessagesRequestContext,
  VercelAgentSessionOptions,
  VercelClientSessionOptions,
} from './transport/index.js';
export { createAgentSession, createChatTransport, createClientSession } from './transport/index.js';

// Vercel-shaped helpers
export { vercelRunEndReason } from './run-end-reason.js';
