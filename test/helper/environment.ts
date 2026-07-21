export const isNonSandboxEnvironment = (): boolean =>
  process.env.VITE_ABLY_ENV !== undefined && process.env.VITE_ABLY_ENV !== 'sandbox';

export const testEndpoint = (): string | undefined => {
  switch (process.env.VITE_ABLY_ENV) {
    case 'local': {
      return 'local-rest.ably.io';
    }
    case 'production': {
      return;
    }
    default: {
      return 'nonprod:sandbox';
    }
  }
};

export const isLocalEnvironment = (): boolean => process.env.VITE_ABLY_ENV === 'local';

export const ablyApiKey = (): string | undefined =>
  isNonSandboxEnvironment() ? process.env.VITE_ABLY_API_KEY : process.env.sandboxApiKey;

/**
 * Base URL of a local sandbox provisioner (e.g. "http://localhost:9010") when
 * the compatibility harness has set ABLY_LOCAL_SANDBOX_URL. When present, the
 * suite provisions its app through this sandbox's POST /apps and routes clients
 * at the isolated server that response describes, instead of the cloud sandbox.
 * Returns undefined (inert, cloud path unchanged) otherwise.
 * @returns The sandbox base URL, or undefined when unset/empty.
 */
export const localSandboxURL = (): string | undefined => process.env.ABLY_LOCAL_SANDBOX_URL || undefined;

/** How to reach the isolated server a local sandbox booted for the test app. */
export interface LocalSandboxRouting {
  /** Endpoint (host) the sandbox reported for the app's server. */
  endpoint: string;
  /** Port the app's server listens on. */
  port: number;
  /** Whether that server terminates TLS. */
  tls: boolean;
}

// Env var names the global setup writes the provisioned app's routing to, read
// back here in the (separate) worker processes — the same cross-process channel
// used for the API key. Local to this module.
const ENDPOINT_VAR = 'ABLY_LOCAL_SANDBOX_ENDPOINT';
const PORT_VAR = 'ABLY_LOCAL_SANDBOX_PORT';
const TLS_VAR = 'ABLY_LOCAL_SANDBOX_TLS';

/**
 * Routing for the local sandbox app provisioned in global setup, or undefined
 * when not running against a local sandbox. Reads the values recorded by
 * {@link recordLocalSandboxRouting}.
 * @returns The recorded routing, or undefined when none was recorded.
 */
export const localSandboxRouting = (): LocalSandboxRouting | undefined => {
  const endpoint = process.env[ENDPOINT_VAR];
  const port = process.env[PORT_VAR];
  if (endpoint === undefined || port === undefined) {
    return undefined;
  }
  return { endpoint, port: Number(port), tls: process.env[TLS_VAR] === 'true' };
};

/**
 * Record (in the environment) how clients should reach the local sandbox app's
 * server, for {@link localSandboxRouting} to read back in the test workers.
 * @param routing - The endpoint/port/tls the sandbox reported for the app.
 */
export const recordLocalSandboxRouting = (routing: LocalSandboxRouting): void => {
  process.env[ENDPOINT_VAR] = routing.endpoint;
  process.env[PORT_VAR] = String(routing.port);
  process.env[TLS_VAR] = String(routing.tls);
};
