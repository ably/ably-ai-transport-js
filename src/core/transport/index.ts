// Shared types
export type {
  ActiveTurn,
  AddMessageOptions,
  AddMessagesResult,
  CancelFilter,
  CancelRequest,
  ClientTransport,
  ClientTransportOptions,
  CloseOptions,
  NewTurnOptions,
  SendOptions,
  ServerTransport,
  ServerTransportOptions,
  StreamResponseOptions,
  StreamResult,
  Tree,
  TreeNode,
  Turn,
  TurnEndReason,
  TurnLifecycleEvent,
  View,
} from './types.js';

// Internal tree interface (consumed by View implementations)
export type { TreeInternal } from './tree.js';

// Server transport
export { createServerTransport } from './server-transport.js';

// Client transport
export { createClientTransport } from './client-transport.js';

// Header builder
export { buildTransportHeaders } from './headers.js';
