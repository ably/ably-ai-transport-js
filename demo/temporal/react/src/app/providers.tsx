'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import type * as AI from 'ai';

import { createClientSession, type ClientSession, type ClientView } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

interface ChatHandle {
  ably: Ably.Realtime;
  session: ClientSession<typeof UIMessageCodec>;
  view: ClientView<typeof UIMessageCodec>;
}

interface ChatBootstrapProps {
  sessionName: string;
  clientId?: string;
  children: (handle: ChatHandle) => ReactNode;
}

/**
 * Owns the Realtime client + ClientSession lifecycle. Renders its `children`
 * function with the session + default view once both are ready.
 */
export function ChatBootstrap({ sessionName, clientId, children }: ChatBootstrapProps) {
  const [handle, setHandle] = useState<ChatHandle | null>(null);
  const handleRef = useRef<ChatHandle | null>(null);

  useEffect(() => {
    let disposed = false;

    const authParams = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
    const ably = new Ably.Realtime({
      authCallback: async (_tokenParams, callback) => {
        try {
          const response = await fetch(`/api/auth/ably-token${authParams}`);
          const jwt = await response.text();
          callback(null, jwt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          callback(message, null);
        }
      },
    });

    const session = createClientSession({
      client: ably,
      sessionName,
      codec: UIMessageCodec,
    });
    const view = session.createView();
    handleRef.current = { ably, session, view };

    const channel = ably.channels.get(sessionName);

    void (async () => {
      try {
        await session.connect();
      } catch (err) {
        console.error('client session failed to connect', err);
        return;
      }
      if (disposed) return;
      try {
        // Ably auto-rejoins presence on reconnect, so one enter() at
        // connect time is enough to keep the member visible for the
        // session's lifetime.
        await channel.presence.enter();
      } catch (err) {
        console.error('failed to enter presence', err);
      }
      if (disposed) return;
      setHandle({ ably, session, view });
    })();

    return () => {
      disposed = true;
      handleRef.current = null;
      view.close();
      // Best-effort: leave presence before tearing down the connection.
      // If it fails (or the connection has already dropped) Ably will
      // expire the member after the connection-loss grace period.
      void channel.presence.leave().catch(() => {});
      void session.close().finally(() => {
        ably.close();
      });
    };
  }, [sessionName, clientId]);

  if (!handle) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting…</div>;
  }
  return <>{children(handle)}</>;
}

/** Re-export the underlying handle types for component prop typing. */
export type { ChatHandle };
export type ChatMessage = AI.UIMessage;
