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

// Vercel-shaped helpers
export type { VercelRunOutcome } from './run-end-reason.js';
export { vercelRunOutcome } from './run-end-reason.js';
export type { PendingToolCall } from './tool-registry.js';
export { approvedPendingToolCalls, pendingToolCalls, stripToolExecutes } from './tool-registry.js';
