let counter = 0;

const randomString = (): string => Math.random().toString(36).slice(7);

/**
 * Generate a random clientId for test isolation.
 * @returns A unique clientId string.
 */
export const randomClientId = (): string => 'ably-ai-transport-client-' + randomString();

/**
 * Generate a unique channel name in the `mutable:` namespace. The `mutable`
 * namespace has message appends/updates enabled in the sandbox app config
 * (`ably-common/test-resources/test-app-setup.json`).
 * @param prefix Optional prefix for readability in test logs.
 * @returns A unique channel name.
 */
export const uniqueChannelName = (prefix = 'integration'): string =>
  `mutable:${prefix}-${String(counter++)}-${randomString()}`;

/**
 * Generate a unique message ID for test publishes.
 * @returns A random message ID string.
 */
export const randomMessageId = (): string => 'msg-' + randomString();
