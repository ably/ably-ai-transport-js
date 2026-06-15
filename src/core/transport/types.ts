/**
 * Core transport types, parameterized by codec event and message types.
 *
 * The definitions live in `./types/`, split along the Tree / View / Session
 * boundary. This barrel re-exports them so consumers keep importing from a
 * single module:
 *
 * - `shared.ts` — cross-cutting (RunEndReason, CancelRequest).
 * - `agent.ts` — agent session, run runtime, Run / AgentSession.
 * - `tree.ts` — conversation-tree nodes, lifecycle events, Tree.
 * - `view.ts` — history pagination, branch selection, View.
 * - `client.ts` — client session options, ActiveRun, ClientSession.
 */

export type * from './types/agent.js';
export type * from './types/client.js';
export type * from './types/shared.js';
export type * from './types/tree.js';
export type * from './types/view.js';
