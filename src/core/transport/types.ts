/**
 * Core transport types, parameterized by codec event types.
 *
 * The definitions live in `./types/`; this barrel re-exports them so
 * consumers keep importing from a single module:
 *
 * - `shared.ts` — cross-cutting (RunEndReason, CancelRequest).
 * - `lifecycle.ts` — the parsed run and step lifecycle events.
 * - `steer.ts` — the steering result surface.
 * - `transport.ts` — the transport send/receive surface (ClientTransport,
 *   AgentTransport, TransportEvent, TransportReceiver, WireMeta).
 */

export type * from './types/lifecycle.js';
export type * from './types/shared.js';
export type * from './types/steer.js';
export type * from './types/transport.js';
