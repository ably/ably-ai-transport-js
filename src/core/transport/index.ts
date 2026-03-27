// Shared types
export type { CancelFilter, MessageWithHeaders, TurnEndReason, TurnLifecycleEvent } from './types.js';

// Client types
export type {
  ActiveTurn,
  ClientTransport,
  ClientTransportOptions,
  CloseOptions,
  ConversationNode,
  ConversationTree,
  LoadHistoryOptions,
  PaginatedMessages,
  SendOptions,
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

// Client transport
export { createClientTransport } from './client/client-transport.js';

// Server transport
export { createServerTransport } from './server/server-transport.js';

// Header builder
export { buildTransportHeaders } from './headers.js';
