// OpenAI Responses wire codec — encode and decode, nothing else
export type {
  FunctionCallOutputEvent,
  ModelledOutputItem,
  OpenAIOutput,
  ToolApprovalRequestEvent,
} from './codec/index.js';
export { ResponsesCodec } from './codec/index.js';
