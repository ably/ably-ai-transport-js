import testAppSetup from '../../ably-common/test-resources/test-app-setup.json' with { type: 'json' };
import { isNonSandboxEnvironment } from './environment.js';

// Setup creates a new app in the sandbox environment and sets the key.
// This is called automatically by vitest before the tests are run.
const setup = async () => {
  // If we're running using a non-sandbox environment, we don't need to do this
  if (isNonSandboxEnvironment()) {
    return;
  }

  // The shared test-app-setup carries ably-js presence-fixture `channels` we
  // don't use here, and the sandbox no longer accepts the `channels` field —
  // strip it before POSTing.
  const { channels: _unusedChannels, ...postBody } = testAppSetup.post_apps;
  void _unusedChannels;

  const response = await fetch('https://sandbox-rest.ably.io/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>');
    throw new Error(`Response not OK (${String(response.status)}): ${text}`);
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
