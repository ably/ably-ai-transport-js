import testAppSetup from '../../ably-common/test-resources/test-app-setup.json' with { type: 'json' };
import { isNonSandboxEnvironment, localSandboxURL, recordLocalSandboxRouting } from './environment.js';

// The appspec provisions several keys with differing capabilities; index 5 is
// the one granting all channel qualifiers and namespaces. Both the cloud
// sandbox and the local sandbox echo the keys in appspec order, so the index
// selects the same key against either.
const WILDCARD_KEY_INDEX = 5;

// The shape of a POST /apps response, from either sandbox. endpoint/port/tls are
// present only from the local sandbox, which boots an isolated server per app.
interface AppResponse {
  keys: { keyStr: string }[];
  endpoint?: string;
  port?: number;
  tls?: boolean;
}

const provisionApp = async (baseURL: string): Promise<AppResponse> => {
  const response = await fetch(`${baseURL}/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testAppSetup.post_apps),
  });

  if (!response.ok) {
    throw new Error(`Response not OK (${String(response.status)})`);
  }

  // CAST: trust boundary — provisioning API response shape.
  return (await response.json()) as AppResponse;
};

const wildcardKeyFrom = (app: AppResponse): string => {
  const key = app.keys[WILDCARD_KEY_INDEX]?.keyStr;
  if (!key) {
    throw new Error(`unable to create test app; key at index ${String(WILDCARD_KEY_INDEX)} not found`);
  }
  return key;
};

// Setup provisions a test app and records its API key. This is called
// automatically by vitest before the tests are run.
const setup = async () => {
  const localURL = localSandboxURL();

  // Against a local sandbox, provision through it and route clients at the
  // isolated server it booted for this app (its own endpoint/port/tls).
  if (localURL) {
    const app = await provisionApp(localURL.replace(/\/+$/, ''));
    process.env.sandboxApiKey = wildcardKeyFrom(app);
    if (app.endpoint === undefined || app.port === undefined) {
      throw new Error('unable to route to local sandbox; app response is missing endpoint/port');
    }
    recordLocalSandboxRouting({ endpoint: app.endpoint, port: app.port, tls: app.tls ?? false });
    return;
  }

  // A non-sandbox environment (local/production) uses a pre-existing app and key.
  if (isNonSandboxEnvironment()) {
    return;
  }

  // Default: provision an app in the cloud sandbox.
  const app = await provisionApp('https://sandbox-rest.ably.io');
  process.env.sandboxApiKey = wildcardKeyFrom(app);
};

export { setup };
