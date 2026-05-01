/**
 * Module-scope cache of the Temporal {@link Client} used by the Next.js
 * agent route. The first request opens the gRPC connection; subsequent
 * requests reuse it.
 */

import { Client, Connection } from '@temporalio/client';

let clientPromise: Promise<Client> | undefined;

export const getTemporalClient = (): Promise<Client> => {
  if (!clientPromise) {
    clientPromise = (async () => {
      const connection = await Connection.connect({
        address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
      });
      return new Client({ connection, namespace: 'default' });
    })();
  }
  return clientPromise;
};
