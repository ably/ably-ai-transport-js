// Shared types
export type {
  ActiveRun,
  AddMessageOptions,
  AddMessagesResult,
  AgentSession,
  AgentSessionOptions,
  CancelFilter,
  CancelRequest,
  ClientSession,
  ClientSessionOptions,
  CloseOptions,
  EventsNode,
  MessageNode,
  PipeOptions,
  Run,
  RunEndReason,
  RunLifecycleEvent,
  RunRuntime,
  RunView,
  SendOptions,
  StreamResult,
  Tree,
  View,
} from './types.js';

// Deprecated aliases — intentional re-export of deprecated types for backwards compatibility.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export type { EventNode } from './types.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated
export type { TreeNode } from './types.js';

// Internal tree interface (consumed by View implementations)
export type { TreeInternal } from './tree.js';

// Invocation
export type { InvocationData } from './invocation.js';
export { Invocation } from './invocation.js';

// Agent session
export { createAgentSession } from './agent-session.js';

// Client session
export { createClientSession } from './client-session.js';

// Header builder
export { buildTransportHeaders } from './headers.js';
