/**
 * useChatTransport: read the {@link ChatTransport} useChat adapter and the
 * {@link ClientTransport} beneath it from the nearest (or a named)
 * {@link import('./contexts/chat-transport-provider.js').ChatTransportProvider}.
 * A thin context reader — it creates no state and manages no lifecycle.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { useContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { VercelInput, VercelOutput } from '../codec/events.js';
import type { ChatTransport } from '../transport/chat-transport.js';
import { ChatTransportContext } from './contexts/chat-transport-context.js';

/** Options for {@link useChatTransport}. */
export interface UseChatTransportOptions {
  /** The channel name of the provider to read. Omit to use the nearest enclosing provider. */
  channelName?: string;
}

/**
 * What {@link useChatTransport} returns: the useChat adapter, the client
 * transport beneath it, and any construction error.
 *
 * Each type parameter defaults to the SDK default, so a bare
 * `ChatTransportHandle` resolves to the all-defaults instantiation.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export interface ChatTransportHandle<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /** The provider's client transport, or `undefined` when construction failed. */
  transport:
    | ClientTransport<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>
    | undefined;
  /** The useChat adapter over {@link transport}, or `undefined` when construction failed. */
  chatTransport: ChatTransport<TMetadata, TDataParts, TTools> | undefined;
  /** The construction error, or `undefined` when the pair exists. */
  error: Ably.ErrorInfo | undefined;
}

/**
 * Read the pair registered by an enclosing
 * {@link import('./contexts/chat-transport-provider.js').ChatTransportProvider}.
 *
 * Supply the type arguments an application's `AI.UIMessage` carries to get a
 * typed pair back — the provider stores the pair at the SDK defaults, and this
 * hook is the boundary that re-applies them.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 * @param options - Optional provider lookup; see {@link UseChatTransportOptions}.
 * @returns The adapter, the transport, and any error; see {@link ChatTransportHandle}.
 * @throws {Ably.ErrorInfo} InvalidArgument when no matching provider encloses the caller.
 */
export const useChatTransport = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: UseChatTransportOptions = {},
): ChatTransportHandle<TMetadata, TDataParts, TTools> => {
  const context = useContext(ChatTransportContext);
  const slot = options.channelName === undefined ? context.nearest : context.providers[options.channelName];
  if (!slot) {
    throw new Ably.ErrorInfo(
      'unable to resolve chat transport; no matching ChatTransportProvider encloses this component',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return {
    // CAST: the provider stores the pair at the SDK's default metadata,
    // data-part and tool types; the caller's type arguments re-apply the
    // application's own at this boundary.
    transport: slot.transport as
      | ClientTransport<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>
      | undefined,
    chatTransport: slot.chatTransport as ChatTransport<TMetadata, TDataParts, TTools> | undefined,
    error: slot.error,
  };
};
