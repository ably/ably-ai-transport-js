/**
 * Returns true when the test run is targeting an environment other than the
 * Ably sandbox. The sandbox path provisions an app on demand; non-sandbox
 * environments require a pre-supplied API key in `VITE_ABLY_API_KEY`.
 * @returns Whether `VITE_ABLY_ENV` names a non-sandbox environment.
 */
export const isNonSandboxEnvironment = (): boolean =>
  process.env.VITE_ABLY_ENV !== undefined && process.env.VITE_ABLY_ENV !== 'sandbox';

/**
 * Resolve the Ably endpoint string for the configured test environment.
 * Returns `undefined` for the production environment so the SDK uses its
 * built-in default.
 * @returns The endpoint string, or `undefined` for production.
 */
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

/**
 * Returns true when `VITE_ABLY_ENV=local` (insecure local dev cluster).
 * @returns `true` when targeting the local cluster.
 */
export const isLocalEnvironment = (): boolean => process.env.VITE_ABLY_ENV === 'local';

/**
 * Resolve the Ably API key for the configured environment. For sandbox runs
 * the key is provisioned in {@link setup} and stored on `process.env`.
 * @returns The API key string, or `undefined` if not configured.
 */
export const ablyApiKey = (): string | undefined =>
  isNonSandboxEnvironment() ? process.env.VITE_ABLY_API_KEY : process.env.sandboxApiKey;
