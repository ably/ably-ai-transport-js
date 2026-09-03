// Vercel AI SDK wire codec — encode and decode, nothing else
export type {
  VercelApprovalDecision,
  VercelApprovalInput,
  VercelChunkInput,
  VercelInput,
  VercelMessageInput,
  VercelOutput,
  VercelRegenerateInput,
  VercelToolOutputChunk,
} from './codec/index.js';
export { createUIMessageCodec } from './codec/index.js';

// Vercel AI SDK transport wrappers (pre-bound to the Vercel codec)
export type {
  ChatTransport,
  ChatTransportOptions,
  ReadSinceResult,
  ReconnectHint,
  VercelAgentTransportOptions,
  VercelClientTransportOptions,
  WalkedEvent,
  WalkedMessage,
} from './transport/index.js';
export { createAgentTransport, createChatTransport, createClientTransport } from './transport/index.js';

// Vercel-shaped helpers
export type { VercelRunOutcome } from './run-end-reason.js';
export { vercelRunOutcome } from './run-end-reason.js';
export type { PendingToolCall } from './tool-registry.js';
export { approvedPendingToolCalls, pendingToolCalls, stripToolExecutes } from './tool-registry.js';
