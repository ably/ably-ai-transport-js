// Shared types
export type {
  AdoptRunOptions,
  AgentRunTransport,
  AgentTransport,
  CancelRequest,
  ClientTransport,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  PipeSource,
  PublishInputOptions,
  PublishInputResult,
  RunEndParams,
  RunEndReason,
  RunEndResult,
  RunLifecycleEvent,
  RunStatus,
  RunStepTransport,
  SteerOutcome,
  SteerResult,
  StepEndParams,
  StepEndReason,
  StepEndResult,
  StepLifecycleEvent,
  StepOptions,
  StreamResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
  TransportReceiver,
  WireMeta,
} from './types.js';

// Standalone transports
export type { AgentTransportOptions } from './agent-transport.js';
export { createAgentTransport } from './agent-transport.js';
export type { ClientTransportOptions } from './client-transport.js';
export { createClientTransport } from './client-transport.js';
export type { DeliverEventResult, ReceiveTransport } from './receive-transport.js';
export { createReceiveTransport } from './receive-transport.js';

// Header builder
export { buildTransportHeaders } from './headers.js';
