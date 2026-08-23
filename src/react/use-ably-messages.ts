/**
 * useAblyMessages — reactive raw Ably message log from a ClientSession.
 *
 * Accumulates raw Ably InboundMessages from the session's tree
 * 'ably-message' event. Messages are appended in arrival order.
 *
 * When `session` is omitted, defaults to the nearest
 * {@link ClientSessionProvider}'s session via context.
 * Pass `skip: true` to bypass all subscriptions and return an empty array.
 */

import type * as Ably from 'ably';
import { useEffect, useRef, useState } from 'react';

import type { CodecInputEvent, CodecOutputEvent } from '../core/transport/session-codec.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Options for {@link useAblyMessages}. */
export interface UseAblyMessagesOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> extends BaseSessionOption<TInput, TOutput, TProjection, TMessage> {
  /** When `true`, skip all subscriptions and return an empty array. */
  skip?: boolean;
}

/**
 * Subscribe to raw Ably message updates from a client session's tree.
 * When `session` is omitted, uses the nearest {@link ClientSessionProvider}'s session via context.
 * @param props - Options including optional `session` and `skip`.
 * @param props.session - Session to subscribe to; defaults to the nearest provider.
 * @param props.skip - When `true`, skip all subscriptions and return an empty array.
 * @returns The accumulated raw Ably messages in event-arrival order — older history messages loaded later are appended after the live messages already present, so this is not strictly chronological.
 */
export const useAblyMessages = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>({ session, skip }: UseAblyMessagesOptions<TInput, TOutput, TProjection, TMessage> = {}): Ably.InboundMessage[] => {
  const resolved = useResolvedSession({ session, skip });

  const [messages, setMessages] = useState<Ably.InboundMessage[]>([]);
  const messagesRef = useRef<Ably.InboundMessage[]>([]);

  useEffect(() => {
    // Reset on session change
    messagesRef.current = [];
    setMessages([]);

    if (!resolved) return;

    const unsub = resolved.tree.on('ably-message', (msg: Ably.InboundMessage) => {
      const next = [...messagesRef.current, msg];
      messagesRef.current = next;
      setMessages(next);
    });
    return unsub;
  }, [resolved]);

  return messages;
};
