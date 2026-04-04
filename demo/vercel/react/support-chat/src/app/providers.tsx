'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';

const AblyReadyContext = createContext(false);

export function useAblyReady() {
  return useContext(AblyReadyContext);
}

export function Providers({ clientId, children }: { clientId?: string; children: ReactNode }) {
  const [client, setClient] = useState<Ably.Realtime | null>(null);

  useEffect(() => {
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
    setClient(ably);
    return () => {
      ably.close();
    };
  }, [clientId]);

  if (!client) {
    return <AblyReadyContext.Provider value={false}>{children}</AblyReadyContext.Provider>;
  }

  return (
    <AblyProvider client={client}>
      <AblyReadyContext.Provider value={true}>{children}</AblyReadyContext.Provider>
    </AblyProvider>
  );
}
