import type * as AI from 'ai';

import type { Codec } from '../../core/codec/index.js';
import { createAccumulator } from './accumulator.js';
import { createDecoder } from './decoder.js';
import { createEncoder } from './encoder.js';

/**
 * Vercel AI SDK codec — maps `UIMessageChunk` events and `UIMessage`
 * objects to and from Ably's native message primitives. Phase 8 ships
 * **text-only** support: `text-start` / `text-delta` / `text-end` for
 * streamed responses, and `text` parts in `encodeMessage` for client-
 * published user messages. Tool input/output, reasoning, files,
 * source-* parts, `data-*`, and AI SDK lifecycle markers are silently
 * dropped on the encode path and ignored on the decode path. Tool
 * support and the rest of the chunk vocabulary land in later phases.
 *
 * ```ts
 * import { UIMessageCodec } from '@ably/ai-transport/vercel';
 * import { createClientSession } from '@ably/ai-transport';
 *
 * const session = createClientSession({ client, sessionName, codec: UIMessageCodec });
 * ```
 */
export const UIMessageCodec: Codec<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage> = {
  createEncoder,
  createDecoder: () => createDecoder(),
  createAccumulator: () => createAccumulator(),
};

export { createAccumulator } from './accumulator.js';
export { createDecoder } from './decoder.js';
export { createEncoder } from './encoder.js';
