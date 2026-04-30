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
  EventsNode,
  MessageNode,
  NewTurnOptions,
  SendOptions,
  ServerTransport,
  ServerTransportOptions,
  StreamResponseOptions,
  StreamResult,
  Tree,
  Turn,
  TurnEndReason,
  TurnLifecycleEvent,
  View,
} from './types.js';

// Deprecated aliases — intentional re-export of deprecated types for backwards compatibility.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export type { EventNode } from './types.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated
export type { TreeNode } from './types.js';

// Internal tree interface (consumed by View implementations)
export type { TreeInternal } from './tree.js';

// Server transport
export { createServerTransport } from './server-transport.js';

// Client transport
export { createClientTransport } from './client-transport.js';

// Header builder
export { buildTransportHeaders } from './headers.js';
