// Shared types
export type { CancelFilter, TreeNode, TurnEndReason, TurnLifecycleEvent } from './types.js';

// Client types
export type {
  ActiveTurn,
  ClientTransport,
  ClientTransportOptions,
  CloseOptions,
  SendOptions,
  Tree,
  View,
} from './client/types.js';

// Server types
export type {
  AddMessageOptions,
  AddMessagesResult,
  CancelRequest,
  NewTurnOptions,
  ServerTransport,
  ServerTransportOptions,
  StreamResponseOptions,
  StreamResult,
  Turn,
} from './server/types.js';

// Internal tree interface (consumed by View implementations)
export type { TreeInternal } from './client/tree.js';

// Client transport
export { createClientTransport } from './client/client-transport.js';

// Server transport
export { createServerTransport } from './server/server-transport.js';

// Header builder
export { buildTransportHeaders } from './headers.js';
