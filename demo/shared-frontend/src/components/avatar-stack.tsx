'use client';

import { usePresence, usePresenceListener } from 'ably/react';

import { clientColor } from '../lib/client-color';

interface AvatarStackProps {
  /** The session channel whose presence set is shown. */
  channelName: string;
  /** This client's own clientId, so its avatar can be marked "(you)". */
  selfClientId?: string;
}

/**
 * Avatar stack of the clients currently present on the session channel.
 *
 * Each present client is one circle showing the first two letters of its
 * clientId, coloured from the same palette as the per-message attribution so a
 * client reads as the same colour everywhere. Entering presence on mount and
 * reading the live member set both call ably-js's React presence hooks
 * directly — they resolve the channel from the `<ChannelProvider>` the SDK's
 * session provider wraps the subtree in.
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
          <div
            key={id}
            title={id === selfClientId ? `${id} (you)` : id}
            className={`flex h-7 w-7 cursor-default select-none items-center justify-center rounded-full text-[10px] font-semibold uppercase text-white ring-2 ring-zinc-900 ${avatarBg}`}
          >
            {id.slice(0, 2)}
          </div>
        );
      })}
    </div>
  );
}
