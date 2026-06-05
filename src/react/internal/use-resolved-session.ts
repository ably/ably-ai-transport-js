import { useContext } from 'react';

import type { CodecInputEvent, CodecOutputEvent } from '../../core/codec/types.js';
import type { ClientSession } from '../../core/transport/types.js';
import { ClientSessionContext } from '../contexts/client-session-context.js';

/**
 * Shared base for hook options that accept an explicit session override.
 * Extend this interface for any hook whose `session` option defaults to the
 * nearest {@link ClientSessionProvider} when omitted. Pass `null` to defer
 * resolution (e.g. when a split pane is collapsed) — the helper returns
 * `undefined` rather than falling back to the nearest provider.
 */
export interface BaseSessionOption<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /**
   * Session to operate on; defaults to the nearest {@link ClientSessionProvider}.
   * Pass `null` to defer (returns undefined; nearest provider is not used).
   */
  session?: ClientSession<TInput, TOutput, TProjection, TMessage> | null;
}

/**
 * Resolve the active `ClientSession` for a hook.
 *
 * Reads `ClientSessionContext` and applies the standard three-way
 * priority: explicit `session` argument → nearest provider → `undefined`.
 * When `skip` is `true`, returns `undefined` regardless of context.
 * When `session` is `null`, returns `undefined` (caller is deferring).
 *
 * Internal — not part of the public API.
 * @param root0 - Options.
 * @param root0.session - Explicit session; takes priority over the nearest provider. `null` to defer.
 * @param root0.skip - When `true`, returns `undefined` immediately; context is still read but its value is ignored.
 * @returns The resolved session, or `undefined` if none is available or `skip` is `true`.
 */
export const useResolvedSession = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>({
  session,
  skip,
}: {
  /** Explicit session; takes priority over the nearest provider. `null` to defer. */
  session?: ClientSession<TInput, TOutput, TProjection, TMessage> | null;
  /** When `true`, return `undefined` immediately (context is still read, but ignored). */
  skip?: boolean;
} = {}): ClientSession<TInput, TOutput, TProjection, TMessage> | undefined => {
  const { nearest } = useContext(ClientSessionContext);
  // CAST: ClientSessionContext stores session with erased generics; types fixed at call site.
  const nearestSession = nearest?.session as unknown as
    | ClientSession<TInput, TOutput, TProjection, TMessage>
    | undefined;
  if (skip) return undefined;
  if (session === null) return undefined;
  return session ?? nearestSession;
};
