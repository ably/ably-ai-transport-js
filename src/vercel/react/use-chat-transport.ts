/**
 * useChatTransport: wraps a core ClientTransport into the ChatTransport
 * shape that Vercel's useChat expects.
 *
 * Accepts either an existing ClientTransport or options to create one:
 * - From an existing ClientTransport — wraps it directly
 * - From options — creates a ClientTransport with UIMessageCodec and wraps it
 *
 * Both forms accept an optional second argument for ChatTransportOptions
 * (e.g. prepareSendMessagesRequest for the persistence pattern).
 *
 * The hook does NOT auto-close the transport on unmount. Channel lifecycle is
 * managed by the Ably provider (useChannel). Auto-closing would break React
 * Strict Mode. Call chatTransport.close() explicitly if needed.
 */

import type * as AI from 'ai';
import { useRef } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';
import type { ChatTransport, ChatTransportOptions } from '../transport/chat-transport.js';
import { createChatTransport } from '../transport/chat-transport.js';
import type { VercelClientTransportOptions } from '../transport/index.js';
import { createClientTransport as createCoreClientTransport } from '../transport/index.js';

/**
 * Type guard: distinguish an existing ClientTransport from options.
 * @param x - Either a transport instance or options object.
 * @returns True if the argument is a ClientTransport instance.
 */
const isClientTransport = (
  x: ClientTransport<AI.UIMessageChunk, AI.UIMessage> | VercelClientTransportOptions,
): x is ClientTransport<AI.UIMessageChunk, AI.UIMessage> => 'send' in x && typeof x.send === 'function';

/**
 * Create and memoize a {@link ChatTransport} for Vercel's useChat hook.
 *
 * Pass an existing `ClientTransport` to wrap it, or pass
 * `VercelClientTransportOptions` to create one internally with UIMessageCodec.
 * @param transportOrOptions - An existing ClientTransport, or options to create one.
 * @param chatOptions - Optional hooks for customizing request construction.
 * @returns A {@link ChatTransport} compatible with Vercel's useChat hook.
 */
export const useChatTransport = (
  transportOrOptions: ClientTransport<AI.UIMessageChunk, AI.UIMessage> | VercelClientTransportOptions,
  chatOptions?: ChatTransportOptions,
): ChatTransport => {
  const chatTransportRef = useRef<ChatTransport | null>(null);

  if (chatTransportRef.current === null) {
    if (isClientTransport(transportOrOptions)) {
      chatTransportRef.current = createChatTransport(transportOrOptions, chatOptions);
    } else {
      const transport = createCoreClientTransport(transportOrOptions);
      chatTransportRef.current = createChatTransport(transport, chatOptions);
    }
  }

  return chatTransportRef.current;
};
