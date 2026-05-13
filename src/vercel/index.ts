// Vercel AI SDK codec
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

// Server-side tool approval helpers
export type {
  PrepareApprovalRunOptions,
  PrepareApprovalRunResult,
  StreamResponseWithApprovalRedirectOptions,
  ToolApprovalDecision,
} from './tool-approvals.js';
export {
  applyToolApprovalsToHistory,
  extractApprovalDecisionsFromHistory,
  prepareApprovalRun,
  streamResponseWithApprovalRedirect,
} from './tool-approvals.js';
