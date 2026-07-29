'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import { LiveObjects } from 'ably/liveobjects';
import { AblyProvider } from 'ably/react';

const AblyReadyContext = createContext(false);

export function useAblyReady() {
  return useContext(AblyReadyContext);
}

/**
 * Set up the Ably client + provider that the shared UI needs. Codec-agnostic:
 * a demo pairs this with its own codec-typed session hooks. `liveObjects` opts
 * the client into the LiveObjects plugin — required by any demo that uses
 * `session.object(...)` (the checklist demo does; the Temporal demo doesn't).
 */
export function Providers({
  clientId,
  liveObjects = false,
  children,
}: {
  clientId?: string;
  liveObjects?: boolean;
  children: ReactNode;
}) {
  const [client, setClient] = useState<Ably.Realtime | null>(null);

  useEffect(() => {
    const authParams = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
    // `NEXT_PUBLIC_ABLY_ENDPOINT` lets the e2e tests point the browser client at
    // the Ably sandbox (`nonprod:sandbox`); unset in normal use, so it defaults
    // to production. It must match the endpoint the agent connects to.
    const endpoint = process.env.NEXT_PUBLIC_ABLY_ENDPOINT;
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
      // LiveObjects is an ably-js plugin — enable it only for demos that call
      // `session.object(...)`. Loading it unconditionally has no functional
      // cost but pulls extra bytes into the browser bundle.
      ...(liveObjects ? { plugins: { LiveObjects } } : {}),
      ...(endpoint ? { endpoint } : {}),
    });
    setClient(ably);
    return () => {
      ably.close();
    };
  }, [clientId, liveObjects]);

  if (!client) {
    return <AblyReadyContext.Provider value={false}>{children}</AblyReadyContext.Provider>;
  }

  return (
    <AblyProvider client={client}>
      <AblyReadyContext.Provider value={true}>{children}</AblyReadyContext.Provider>
    </AblyProvider>
  );
}
