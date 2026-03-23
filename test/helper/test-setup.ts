import testAppSetup from '../../ably-common/test-resources/test-app-setup.json';
import { isNonSandboxEnvironment } from './environment.js';

// Setup creates a new app in the sandbox environment and sets the key.
// This is called automatically by vitest before the tests are run.
const setup = async () => {
  // If we're running using a non-sandbox environment, we don't need to do this
  if (isNonSandboxEnvironment()) {
    return;
  }

  const response = await fetch('https://sandbox-rest.ably.io/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testAppSetup.post_apps),
  });

  if (!response.ok) {
    throw new Error(`Response not OK (${String(response.status)})`);
  }

  // CAST: Trust boundary — sandbox API response shape.
  const testApp = (await response.json()) as { keys: { keyStr: string }[] };

  // The key we need to use is the one at index 5, which gives enough permissions
  // to interact with all channel qualifiers and namespaces
  const key = testApp.keys[5]?.keyStr;
  if (!key) {
    throw new Error('unable to create sandbox app; key at index 5 not found');
  }

  process.env.sandboxApiKey = key;
};

export { setup };
