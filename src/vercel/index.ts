// Vercel AI SDK codec
//
// `ForkSeed` is intentionally NOT re-exported here: it is an internal fork
// reconstruction detail (see `createToolResultFork`), not part of the public
// surface. The approval-response payload is likewise kept internal.
export type {
  VercelInput,
  VercelOutput,
  VercelProjection,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './codec/index.js';
export { createUIMessageCodec } from './codec/index.js';

// Vercel AI SDK transport wrappers (pre-bound to the Vercel codec)
export type {
  ChatTransport,
  ChatTransportOptions,
  SendMessagesRequestContext,
  VercelAgentSessionContext,
  VercelAgentSessionOptions,
  VercelClientSessionOptions,
  VercelWithAgentSessionOptions,
} from './transport/index.js';
export { createAgentSession, createChatTransport, createClientSession, withAgentSession } from './transport/index.js';

// Client tool-result forking (for callers that drive `view.send` directly)
export type { ToolCallResolution } from './transport/fork-tool-result.js';
export { createToolResultFork } from './transport/fork-tool-result.js';

// Vercel-shaped helpers
export type { FinishableRun, FinishableStep, VercelRunOutcome } from './run-end-reason.js';
export { finishRun, finishStep, vercelRunOutcome } from './run-end-reason.js';
export type { PendingToolCall } from './tool-registry.js';
export { approvedPendingToolCalls, pendingToolCalls, stripToolExecutes } from './tool-registry.js';
