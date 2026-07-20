// Shared types
export type {
  AdoptedRun,
  AdoptIdentity,
  AgentRun,
  AgentSession,
  AgentSessionOptions,
  BaseRun,
  BranchHandle,
  CancelRequest,
  ClientRun,
  ClientSession,
  ClientSessionOptions,
  ClientView,
  ConversationNode,
  InputNode,
  OpenableRun,
  OutputEvent,
  PipeOptions,
  RunEndParams,
  RunEndReason,
  RunInfo,
  RunLifecycleEvent,
  RunNode,
  RunNodeState,
  RunRuntime,
  RunStatus,
  RunStep,
  SendOptions,
  StepEndParams,
  StepEndReason,
  StepInfo,
  StepOptions,
  StreamResult,
  Tree,
  View,
} from './types.js';

// Invocation
export type { InvocationData } from './invocation.js';
export { Invocation } from './invocation.js';

// Agent session
export { createAgentSession } from './agent-session.js';

// Client session
export { createClientSession } from './client-session.js';

// Header builder
export { buildTransportHeaders } from './headers.js';

// Raw-message helpers (sharing the channel with plain Pub/Sub)
export type { FetchRawHistoryOptions, MergedConversationItem, MergedItem, MergedRawItem } from './raw-messages.js';
export {
  fetchRawHistory,
  isForeignMessage,
  isTransportMessage,
  mergeBySerial,
  runStartSerialOf,
} from './raw-messages.js';
