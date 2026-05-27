import type * as Ably from 'ably';

/**
 * Loads historical state into a session during connect(). The SDK ships a
 * channel history provider as the default. Developers implement this for
 * external stores (database, cache) or durable-execution framework state.
 *
 * The session materialises from whatever the reader yields, regardless of
 * source. Two sessions hydrated from different sources with the same data
 * arrive at the same state.
 */
export interface StorageReader {
  /**
   * Yield encoded channel messages in serial order.
   * The session materialises each message as it arrives.
   */
  read(): AsyncIterable<Ably.Message>;
}

/**
 * Receives channel messages as the session processes them, for external
 * persistence. The writer decides what to persist, how to batch, and how
 * to handle errors. The session does not retry on write failure.
 */
export interface StorageWriter {
  /**
   * Called for each channel message the session processes, including both
   * historical messages (during hydration) and live messages.
   */
  write(message: Ably.Message): Promise<void>;
}
