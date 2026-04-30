import type * as Ably from 'ably';

/**
 * SDK-owned header names attached to every content message published through
 * the SDK. Receivers read these to attribute and route messages without
 * inspecting the codec's payload.
 *
 * Phase 2 introduces the three identity headers; later phases extend this
 * set with `x-ably-run-id`, `x-ably-step-id`, `x-ably-status`, etc.
 */
export const Headers = {
  /** Unique message ID — appears on every chunk of a streaming message. */
  MessageId: 'x-ably-msg-id',
  /** Protocol-level role — `'user'` or `'assistant'`. */
  Role: 'x-ably-role',
  /**
   * Optional override of the publishing connection's clientId, used when a
   * backend publishes on behalf of an end-user.
   */
  ClientId: 'x-ably-client-id',
} as const;

/** Union of valid SDK header names. */
export type HeaderName = (typeof Headers)[keyof typeof Headers];

/**
 * Read one of the SDK's `x-ably-*` string headers from an inbound message.
 * Returns `undefined` if `extras.headers` is absent or the value is missing
 * or not a string.
 *
 * Headers travel inside `extras.headers`; the Ably SDK types `extras` as
 * `any`, so this helper centralises the runtime narrowing instead of
 * spreading casts across callers.
 * @param message The inbound message to read from.
 * @param name The header name to read.
 * @returns The string header value, or `undefined` if not present.
 */
export const readHeader = (message: Ably.InboundMessage, name: HeaderName): string | undefined => {
  // CAST: Ably types `extras` as `any` (see Ably.Message). Narrow defensively
  // — only return the value when `extras.headers[name]` is genuinely a string.
  const extras = message.extras as { headers?: Record<string, unknown> } | undefined;
  const value = extras?.headers?.[name];
  return typeof value === 'string' ? value : undefined;
};
