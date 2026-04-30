import testAppSetup from '../../ably-common/test-resources/test-app-setup.json' with { type: 'json' };
import { isNonSandboxEnvironment } from './environment.js';

/**
 * Vitest globalSetup hook for integration tests. Provisions a fresh sandbox
 * app via the public sandbox REST API and stashes the API key on
 * `process.env` for {@link ablyApiKey} to pick up. No-op when running
 * against a pre-configured non-sandbox environment.
 */
export const setup = async (): Promise<void> => {
  if (isNonSandboxEnvironment()) {
    return;
  }

  const response = await fetch('https://sandbox-rest.ably.io/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testAppSetup.post_apps),
  });

  if (!response.ok) {
    throw new Error(`unable to provision sandbox app; status ${String(response.status)}`);
  }

  // CAST: trust boundary — sandbox API response shape.
  const testApp = (await response.json()) as { keys: { keyStr: string }[] };

  // The key at index 5 has the broadest permissions across channel namespaces.
  const key = testApp.keys[5]?.keyStr;
  if (!key) {
    throw new Error('unable to provision sandbox app; key at index 5 not found');
  }

  process.env.sandboxApiKey = key;
};
