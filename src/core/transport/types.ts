/**
 * Core transport types, parameterized by codec event and message types.
 *
 * The definitions live in `./types/`, split along the Tree / View / Session
 * boundary. This barrel re-exports them so consumers keep importing from a
 * single module:
 *
 * - `shared.ts` — cross-cutting (RunEndReason, CancelRequest).
 * - `agent-types.ts` — agent session, run runtime, Run / AgentSession.
 * - `tree-types.ts` — conversation-tree nodes, lifecycle events, Tree.
 * - `view-types.ts` — history pagination, branch selection, View.
 * - `client-types.ts` — client session options, ActiveRun, ClientSession.
 */

export type * from './types/agent-types.js';
export type * from './types/client-types.js';
export type * from './types/shared.js';
export type * from './types/tree-types.js';
export type * from './types/view-types.js';
