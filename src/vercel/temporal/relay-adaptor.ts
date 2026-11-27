import type * as AI from 'ai';

import type { AgentAdaptorOptions, RelayAdaptorFactory } from '../../core/adaptor/index.js';
import { createMappedRelayAdaptor } from '../../core/adaptor/relay-adaptor.js';
import type { VercelEvent } from '../codec/events.js';
import { createVercelCodec } from '../codec/index.js';
import { chunkOfModelStreamPart } from './model-stream.js';

/**
 * Create the relay adaptor factory for an agent workflow that streams its
 * model calls through Temporal's AI SDK plugin (`@temporalio/vercel-ai-sdk`),
 * for the Pub/Sub SDK's relay (`AblyRelayPlugin` in
 * `@ably/pubsub-server/temporal`). It writes the Vercel AI SDK's
 * `UIMessageChunk`s, so a client reads the reply with `vercelDecoder()` or
 * `createChatTransport()`. Register it under a name in the plugin's
 * `adaptors`, and name that adaptor in the route whose topics carry the
 * plugin's `streamingTopic` and the workflow's own chunks:
 *
 * ```ts
 * new AblyRelayPlugin({ pool, adaptors: { vercel: vercelTemporalRelayAdaptor() } });
 * ```
 *
 * A route's events can be of two kinds, told apart by their data:
 *
 * - An event published as bytes is a model stream part, as the plugin's
 *   streaming model Activity publishes each part of a call to its
 *   `streamingTopic`. It is written as the chunk `toUIMessageStream` would
 *   give for it: text, reasoning and tool input stream, a tool call becomes
 *   `tool-input-available`, the call's `stream-start` and `finish` open and
 *   end a step, and an `error` becomes an `error` chunk with the AI SDK's
 *   default masked text. A part the AI SDK gives no chunk for, such as
 *   `response-metadata`, writes nothing.
 * - An event the workflow published as an object is a {@link VercelEvent},
 *   written as it is. The plugin publishes no chunk that opens or ends a
 *   reply, so the workflow publishes the reply's `start` and `finish`, and
 *   any chunk it makes itself, such as a tool's output. They share the
 *   route, and so the writer, with the model's parts, which keeps them in
 *   the order the workflow published them.
 *
 * An event of a type the adaptor cannot write, a chunk the codec has no row
 * for or a model part with no mapping here (`file`, say, or a type newer
 * than this package), throws an `InvalidArgument` that carries
 * `type: 'AblyRelayUnsupportedEvent'`, which asks the relay to skip that one
 * event, log it and count it, and carry on with the next.
 *
 * Each activity attempt writes its events through an event writer, and the
 * relay's checkpoints carry the writer's handoff, so a response a checkpoint
 * or a retry cuts carries on in the same message, and a decoder decodes it as
 * one writer's. A retried relay activity writes the events since the last
 * checkpoint again, and a retried model Activity publishes its parts again
 * after the failed attempt's, so a subscriber can decode text twice.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing the user message's tool parts.
 * @param options - See {@link AgentAdaptorOptions}.
 * @returns The factory. Its adaptor's `write` throws `InvalidArgument` for bytes that are not a JSON stream part with a string `type`, or a part lacking a field its chunk needs.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a default header value is not a string, number, boolean or null.
 */
export const vercelTemporalRelayAdaptor = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: AgentAdaptorOptions = {},
): RelayAdaptorFactory<VercelEvent<TMetadata, TDataParts, TTools> | Uint8Array> =>
  createMappedRelayAdaptor(
    createVercelCodec<TMetadata, TDataParts, TTools>(),
    options,
    (data: VercelEvent<TMetadata, TDataParts, TTools> | Uint8Array) =>
      data instanceof Uint8Array ? chunkOfModelStreamPart(data) : data,
  );
