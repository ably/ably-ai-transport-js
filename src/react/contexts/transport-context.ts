import type * as Ably from 'ably';
import { createContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

/**
 * A single entry in the transport registry, holding the transport and any
 * error that occurred during its construction.
 *
 * `transport` is `undefined` when construction failed.
 * `error` is set when `createClientTransport` threw during provider render.
 */
export interface TransportSlot {
  /** The constructed transport, or `undefined` if construction failed. */
  transport: ClientTransport<unknown, unknown> | undefined;
  /** Construction error from `createClientTransport`, or `undefined` on success. */
  transportError?: Ably.ErrorInfo | undefined;
}

/**
 * The shape of the {@link TransportContext} value.
 *
 * `nearest` is the slot from the innermost enclosing {@link TransportProvider}.
 * `providers` is the full registry of all enclosing providers, keyed by channelName.
 */
export interface TransportContextValue {
  /** The innermost {@link TransportProvider}'s slot. `undefined` when no provider is present. */
  nearest: TransportSlot | undefined;
  /** All registered transport slots from enclosing providers, keyed by channelName. */
  providers: Readonly<Record<string, TransportSlot>>;
}

/**
 * Unified transport context.
 *
 * Holds the nearest transport slot and the full registry of all registered
 * slots keyed by channelName. Populated by {@link TransportProvider};
 * read by {@link useClientTransport} and internal hooks.
 */
export const TransportContext = createContext<TransportContextValue>({ nearest: undefined, providers: {} });
