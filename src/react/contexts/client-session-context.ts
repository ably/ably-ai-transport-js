import type * as Ably from 'ably';
import { createContext } from 'react';

import type { CodecInputEvent, CodecOutputEvent } from '../../core/transport/session-codec.js';
import type { ClientSession } from '../../core/transport/types.js';

/**
 * A single entry in the client-session registry, holding the session and any
 * error that occurred during its construction.
 *
 * `session` is `undefined` when construction failed.
 * `sessionError` is set when `createClientSession` threw during provider render.
 */
export interface ClientSessionSlot {
  /** The constructed session, or `undefined` if construction failed. */
  session: ClientSession<CodecInputEvent, CodecOutputEvent, unknown, unknown> | undefined;
  /** Construction error from `createClientSession`, or `undefined` on success. */
  sessionError?: Ably.ErrorInfo | undefined;
}

/**
 * The shape of the {@link ClientSessionContext} value.
 *
 * `nearest` is the slot from the innermost enclosing {@link ClientSessionProvider}.
 * `providers` is the full registry of all enclosing providers, keyed by channelName.
 */
interface ClientSessionContextValue {
  /** The innermost {@link ClientSessionProvider}'s slot. `undefined` when no provider is present. */
  nearest: ClientSessionSlot | undefined;
  /** All registered session slots from enclosing providers, keyed by channelName. */
  providers: Readonly<Record<string, ClientSessionSlot>>;
}

/**
 * Unified client-session context.
 *
 * Holds the nearest client-session slot and the full registry of all registered
 * slots keyed by channelName. Populated by {@link ClientSessionProvider};
 * read by {@link useClientSession} and internal hooks.
 */
export const ClientSessionContext = createContext<ClientSessionContextValue>({ nearest: undefined, providers: {} });
