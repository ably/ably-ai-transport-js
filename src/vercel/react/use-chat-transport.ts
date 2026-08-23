/**
 * useChatTransport: reads a ChatTransport and its underlying ClientSession from
 * the nearest ChatTransportProvider.
 *
 * The chat transport is created by ChatTransportProvider, which wraps the subtree
 * with ClientSessionProvider. The Ably Realtime client is read from the
 * surrounding `<AblyProvider>`. This hook is a thin context reader — it does
 * not create or manage any session/transport state.
 *
 * Pass `channelName` to look up a specific provider by name. Omit to use the nearest
 * provider in the tree. Pass `skip: true` to defer (e.g. when auth is not yet resolved)
 * — returns stubs whose properties throw with a descriptive error.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { useContext } from 'react';

import type { ClientSession } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import { makeSkippedClientSession } from '../../react/internal/skipped-session.js';
import type { VercelOutput } from '../codec/index.js';
import type { VercelProjection } from '../codec/reducer.js';
import type { VercelSessionInput } from '../codec/session-events.js';
import type { ChatTransport } from '../transport/index.js';
import { ChatTransportContext } from './contexts/chat-transport-context.js';

const SKIPPED_CHAT_TRANSPORT: ChatTransport = {
  sendMessages: (): never => {
    throw new Ably.ErrorInfo('unable to send messages; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  reconnectToStream: (): never => {
    throw new Ably.ErrorInfo('unable to reconnect to stream; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  close: (): never => {
    throw new Ably.ErrorInfo('unable to close; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  get streaming(): never {
    throw new Ably.ErrorInfo('unable to access streaming; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  onStreamingChange: (): never => {
    throw new Ably.ErrorInfo(
      'unable to subscribe to streaming changes; hook is skipped',
      ErrorCode.InvalidArgument,
      400,
    );
  },
};

/** Options for {@link useChatTransport}. */
export interface UseChatTransportOptions {
  /** Channel name to look up; omit to use the nearest {@link ChatTransportProvider}. */
  channelName?: string;
  /** When `true`, return stubs that throw on any access. */
  skip?: boolean;
}

/**
 * The value returned by {@link useChatTransport}.
 * Provides both the underlying {@link ClientSession} and the {@link ChatTransport}
 * adapter for Vercel's useChat hook.
 */
export interface ChatTransportHandle {
  /**
   * The underlying client session, also available via {@link useClientSession}.
   * A throwing stub when `skip` is `true`, when no matching {@link ClientSessionProvider}
   * was found in the tree, or when session construction failed. Check `sessionError` before use.
   */
  session: ClientSession<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>;

  /**
   * The chat transport adapter for use with Vercel's `useChat` hook.
   *
   * A throwing stub when `skip` is `true` or when no matching
   * {@link ChatTransportProvider} was found in the tree. When a provider is found
   * but the underlying {@link ClientSession} failed to construct, this is the real
   * transport and `sessionError` is set instead. Check `chatTransportError` and
   * `sessionError` before use.
   */
  chatTransport: ChatTransport;

  /**
   * Set when no matching {@link ClientSessionProvider} was found, when session
   * construction failed, and `skip` is `false`.
   * `undefined` when the session resolved successfully or when `skip` is `true`.
   */
  sessionError?: Ably.ErrorInfo | undefined;
  /**
   * Set only when no matching {@link ChatTransportProvider} was found and `skip` is
   * `false`.
   * `undefined` when the chat transport resolved successfully (even if session
   * construction failed — see `sessionError`) or when `skip` is `true`.
   */
  chatTransportError?: Ably.ErrorInfo | undefined;
}

/**
 * Access a {@link ChatTransport} and {@link ClientSession} from the nearest {@link ChatTransportProvider}.
 *
 * When `channelName` is omitted, the innermost `ChatTransportProvider` in the tree is used.
 * When `skip` is `true`, returns stubs whose every property and method throws
 * an {@link Ably.ErrorInfo} — safe to hold in state before conditions are ready.
 * When no provider is found, returns stubs with `chatTransportError` set instead of throwing.
 * @param props - Options for selecting the chat transport.
 * @param props.channelName - The channel name passed to the enclosing `ChatTransportProvider`. Omit to use the nearest.
 * @param props.skip - When `true`, return stubs that throw on any access instead of reading from context.
 * @returns The `ChatTransportHandle` containing both the chat transport adapter and the underlying client session.
 */
export const useChatTransport = ({ channelName, skip }: UseChatTransportOptions = {}): ChatTransportHandle => {
  const { nearest, providers } = useContext(ChatTransportContext);

  if (skip) {
    return {
      session: makeSkippedClientSession<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>(),
      chatTransport: SKIPPED_CHAT_TRANSPORT,
    };
  }

  if (channelName !== undefined) {
    const slot = providers[channelName];
    if (slot) {
      return { session: slot.session, chatTransport: slot.chatTransport, sessionError: slot.sessionError };
    }
    return {
      session: makeSkippedClientSession<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>(),
      chatTransport: SKIPPED_CHAT_TRANSPORT,
      sessionError: new Ably.ErrorInfo(
        `unable to use client session; no ClientSessionProvider found for channelName "${channelName}"`,
        ErrorCode.BadRequest,
        400,
      ),
      chatTransportError: new Ably.ErrorInfo(
        `unable to use chat transport; no ChatTransportProvider found for channelName "${channelName}"`,
        ErrorCode.BadRequest,
        400,
      ),
    };
  }

  if (nearest) {
    return {
      session: nearest.session,
      chatTransport: nearest.chatTransport,
      sessionError: nearest.sessionError,
    };
  }

  return {
    session: makeSkippedClientSession<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>(),
    chatTransport: SKIPPED_CHAT_TRANSPORT,
    sessionError: new Ably.ErrorInfo(
      'unable to use session; no ClientSessionProvider found in the tree',
      ErrorCode.BadRequest,
      400,
    ),
    chatTransportError: new Ably.ErrorInfo(
      'unable to use chat transport; no ChatTransportProvider found in the tree',
      ErrorCode.BadRequest,
      400,
    ),
  };
};
