/**
 * Core transport types, parameterized by codec event and message types.
 *
 * The definitions live in `./types/`, split along the Tree / View / Session
 * boundary. This barrel re-exports them so consumers keep importing from a
 * single module:
 *
 * - `shared.ts` — cross-cutting (RunEndReason, RunStatus, CancelRequest).
 * - `run.ts` — the shared run read-model base (BaseRun).
 * - `agent.ts` — agent session, run runtime, AgentRun / AgentSession.
 * - `tree.ts` — conversation-tree nodes, lifecycle events, Tree.
 * - `view.ts` — history pagination, branch selection, View.
 * - `client.ts` — client session options, ClientRun, ClientSession.
 * - `transport.ts` — the transport send/receive surface (ClientTransport,
 *   AgentTransport, TransportEvent, TransportReceiver, WireMeta).
 */

export type * from './types/agent.js';
export type * from './types/client.js';
export type * from './types/run.js';
export type * from './types/shared.js';
export type * from './types/transport.js';
export type * from './types/tree.js';
export type * from './types/view.js';
