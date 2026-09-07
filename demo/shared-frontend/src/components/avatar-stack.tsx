'use client';

import { usePresence, usePresenceListener } from 'ably/react';

import { Avatar, AvatarFallback } from './ui/avatar';
import { clientColor } from '../lib/client-color';

interface AvatarStackProps {
  /** The conversation channel whose presence set is shown. */
  channelName: string;
  /** This client's own clientId, so its avatar can be marked "(you)". */
  selfClientId?: string;
}

/**
 * Avatar stack of the clients currently present on the conversation channel.
 *
 * Each present client is one circle showing the first two letters of its
 * clientId, coloured from the same palette as the per-message attribution so a
 * client reads as the same colour everywhere. Entering presence on mount and
 * reading the live member set both call ably-js's React presence hooks
 * directly — they resolve the channel from the `<ChannelProvider>` the SDK's
 * transport provider wraps the subtree in.
 */
export function AvatarStack({ channelName, selfClientId }: AvatarStackProps) {
  // Enter presence when the page opens; the clientId travels in the Ably token.
  usePresence(channelName);
  const { presenceData } = usePresenceListener(channelName);

  // One avatar per clientId — a client may hold several connections, each its
  // own presence member. Sorted for a stable left-to-right order.
  const clientIds = [...new Set(presenceData.map((member) => member.clientId))].sort((a, b) => a.localeCompare(b));

  if (clientIds.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center -space-x-2">
      {clientIds.map((id) => {
        const { avatarBg } = clientColor(id);
        return (
          <Avatar
            key={id}
            title={id === selfClientId ? `${id} (you)` : id}
            className="size-7 ring-2 ring-background"
          >
            <AvatarFallback className={`text-[10px] font-semibold uppercase text-white ${avatarBg}`}>
              {id.slice(0, 2)}
            </AvatarFallback>
          </Avatar>
        );
      })}
    </div>
  );
}
