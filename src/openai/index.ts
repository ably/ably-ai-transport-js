// OpenAI Responses wire codec — encode and decode, nothing else
export type {
  OpenAIApprovalDecision,
  OpenAIApprovalInput,
  OpenAIInput,
  OpenAIItem,
  OpenAIItemInput,
  OpenAIMessage,
  OpenAIMessageInput,
  OpenAIOutput,
  OpenAIRegenerateInput,
  OpenAIToolCallState,
  ToolApprovalRequestEvent,
} from './codec/index.js';
export { ResponsesCodec } from './codec/index.js';

// OpenAI Responses session codec — the wire codec plus the reducer, the
// `getMessages` projection read, and the well-known input factories. This is
// the codec the sessions consume: `createClientSession`, `createAgentSession`
// and `ClientSessionProvider` all require it, and a caller naming their types
// needs `OpenAISessionInput` and `OpenAIProjection`.
//
// It is NOT wire-compatible with the wire codec above. The two model the same
// operations with different `kind` headers and different bodies, so a peer on
// one reads nothing a peer on the other publishes. Pick one per channel.
export type { OpenAIProjection } from './codec/reducer.js';
export { ResponsesSessionCodec } from './codec/session-codec.js';
export type {
  OpenAISessionInput,
  OpenAIToolApprovalResponsePayload,
  OpenAIToolResultErrorPayload,
  OpenAIToolResultPayload,
} from './codec/session-events.js';

// Model-input conversion
export { toResponsesInput } from './to-responses-input.js';

// Loop correlation readers
export { approvedUnexecutedCalls, resolvedCallIds, unansweredCalls } from './correlation.js';
