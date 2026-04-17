/**
 * useChatTransport: reads a ChatTransport and its underlying ClientTransport from
 * the nearest ChatTransportProvider.
 *
 * The transport is created by ChatTransportProvider, which also wraps the subtree
 * with TransportProvider and Ably's ChannelProvider. This hook is a thin context
 * reader — it does not create or manage any transport state.
 *
 * Pass `channelName` to look up a specific provider by name. Omit to use the nearest
 * provider in the tree. Pass `skip: true` to defer (e.g. when auth is not yet resolved)
 * — returns stub transports whose properties throw with a descriptive error.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { useContext } from 'react';

import type { ClientTransport, Tree, View } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { ChatTransport } from '../transport/index.js';
import { ChatTransportContext } from './contexts/chat-transport-context.js';

const SKIPPED_CLIENT_TRANSPORT: ClientTransport<AI.UIMessageChunk, AI.UIMessage> = {
  get tree(): Tree<AI.UIMessage> {
    throw new Ably.ErrorInfo('unable to access tree; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  get view(): View<AI.UIMessageChunk, AI.UIMessage> {
    throw new Ably.ErrorInfo('unable to access view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  createView: (): View<AI.UIMessageChunk, AI.UIMessage> => {
    throw new Ably.ErrorInfo('unable to create view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  cancel: () => {
    throw new Ably.ErrorInfo('unable to cancel; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  waitForTurn: () => {
    throw new Ably.ErrorInfo('unable to wait for turn; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  on: () => {
    throw new Ably.ErrorInfo('unable to subscribe; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  close: () => {
    throw new Ably.ErrorInfo('unable to close; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
};

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
  /** When `true`, return stub transports that throw on any access. */
  skip?: boolean;
}

/**
 * The value returned by {@link useChatTransport}.
 * Provides both the underlying {@link ClientTransport} and the {@link ChatTransport}
 * adapter for Vercel's useChat hook.
 */
export interface ChatTransportHandle {
  /** The underlying client transport, also available via {@link useClientTransport}. */
  transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>;
  /** The chat transport adapter for use with Vercel's useChat hook. */
  chatTransport: ChatTransport;
  /**
   * Set when no matching {@link ChatTransportProvider} was found or when transport
   * construction failed, and `skip` is `false`.
   * `undefined` when the transport resolved successfully or when `skip` is `true`.
   */
  chatTransportError?: Ably.ErrorInfo;
}

/**
 * Access a {@link ChatTransport} and {@link ClientTransport} from the nearest {@link ChatTransportProvider}.
 *
 * When `channelName` is omitted, the innermost `ChatTransportProvider` in the tree is used.
 * When `skip` is `true`, returns stub transports whose every property and method throws
 * an {@link Ably.ErrorInfo} — safe to hold in state before conditions are ready.
 * When no provider is found, returns stubs with `chatTransportError` set instead of throwing.
 * @param props - Options for selecting the transport.
 * @param props.channelName - The channel name passed to the enclosing `ChatTransportProvider`. Omit to use the nearest.
 * @param props.skip - When `true`, return stubs that throw on any access instead of reading from context.
 * @returns The `ChatTransportHandle` containing both the chat transport adapter and the underlying client transport.
 */
export const useChatTransport = ({ channelName, skip }: UseChatTransportOptions = {}): ChatTransportHandle => {
  const { nearest, providers } = useContext(ChatTransportContext);

  if (skip) {
    return { transport: SKIPPED_CLIENT_TRANSPORT, chatTransport: SKIPPED_CHAT_TRANSPORT };
  }

  if (channelName !== undefined) {
    const slot = providers[channelName];
    if (slot) {
      return { transport: slot.transport, chatTransport: slot.chatTransport, chatTransportError: slot.transportError };
    }
    return {
      transport: SKIPPED_CLIENT_TRANSPORT,
      chatTransport: SKIPPED_CHAT_TRANSPORT,
      chatTransportError: new Ably.ErrorInfo(
        `unable to use chat transport; no ChatTransportProvider found for channelName "${channelName}"`,
        ErrorCode.BadRequest,
        400,
      ),
    };
  }

  if (nearest) {
    return {
      transport: nearest.transport,
      chatTransport: nearest.chatTransport,
      chatTransportError: nearest.transportError,
    };
  }

  return {
    transport: SKIPPED_CLIENT_TRANSPORT,
    chatTransport: SKIPPED_CHAT_TRANSPORT,
    chatTransportError: new Ably.ErrorInfo(
      'unable to use chat transport; no ChatTransportProvider found in the tree',
      ErrorCode.BadRequest,
      400,
    ),
  };
};
