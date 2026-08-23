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

// Vercel AI SDK session codec — the wire codec plus the reducer, the
// `getMessages` projection read, and the well-known input factories. This is
// the codec the sessions consume: `createClientSession`, `createAgentSession`,
// `withAgentSession` and `ClientSessionProvider` all require it, and a caller
// naming their types needs `VercelSessionInput` and `VercelProjection`.
//
// It is NOT wire-compatible with the wire codec above. The two model the same
// operations with different `kind` headers and different bodies — a session
// user message is `user-message`, a wire one is `message` — so a peer on one
// reads nothing a peer on the other publishes. Pick one per channel.
export type { VercelProjection } from './codec/reducer-state.js';
export { createUIMessageSessionCodec } from './codec/session-codec.js';
export type {
  VercelSessionInput,
  VercelToolApprovalResponsePayload,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './codec/session-events.js';

// Vercel AI SDK transport wrappers (pre-bound to the Vercel codec)
export type {
  ChatTransport,
  ChatTransportOptions,
  VercelAgentTransportOptions,
  VercelClientTransportOptions,
} from './transport/index.js';
export { createAgentTransport, createChatTransport, createClientTransport } from './transport/index.js';

// Vercel-shaped helpers
export type { VercelRunOutcome } from './run-end-reason.js';
export { vercelRunOutcome } from './run-end-reason.js';
export type { PendingToolCall } from './tool-registry.js';
export { approvedPendingToolCalls, pendingToolCalls, stripToolExecutes } from './tool-registry.js';
