// OpenAI Responses codec
export type {
  OpenAIInput,
  OpenAIItem,
  OpenAIMessage,
  OpenAIOutput,
  OpenAIProjection,
  OpenAIToolApprovalResponsePayload,
  OpenAIToolCallState,
  OpenAIToolResultErrorPayload,
  OpenAIToolResultPayload,
  ToolApprovalRequestEvent,
} from './codec/index.js';
export { ResponsesCodec } from './codec/index.js';

// Model-input conversion
export { toResponsesInput } from './to-responses-input.js';

// Loop correlation readers
export { approvedUnexecutedCalls, resolvedCallIds, unansweredCalls } from './correlation.js';
