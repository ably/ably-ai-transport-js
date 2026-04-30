let counter = 0;

const randomString = (): string => Math.random().toString(36).slice(7);

/**
 * Generate a random client ID for test isolation.
 * @returns A unique client ID string.
 */
export const randomClientId = (): string => 'ably-ai-transport-client-' + randomString();

/**
 * Generate a unique channel name in the `mutable:` namespace.
 * The `mutable` namespace has message appends enabled (`mutableMessages: true`)
 * in ably-common/test-resources/test-app-setup.json.
 * @param prefix - Optional prefix for the channel name.
 * @returns A unique channel name.
 */
export const uniqueChannelName = (prefix = 'integration'): string =>
  `mutable:${prefix}-${String(counter++)}-${randomString()}`;
