/**
 * The relay adaptor: an event writer in the shape of the adaptor that the
 * Pub/Sub SDK's Temporal Workflow Streams relay (`AblyRelayPlugin` in
 * `@ably/pubsub-server/temporal`) writes a route's events to.
 *
 * The relay creates one adaptor per activity attempt, from the handoff of the
 * route's last checkpoint, and stores the handoff each `flush` and `close`
 * resolves with in its next checkpoint. That handoff is the event writer's, so
 * an attempt adopts the streams the last checkpoint left open and carries each
 * on in the same message: a response that a checkpoint or a retry cuts stays
 * on one serial.
 *
 * The relay's types are declared here structurally rather than imported, so
 * this package takes no dependency on Temporal or on the relay's entry point.
 * A factory this module returns is assignable to the relay's
 * `RelayAdaptorFactory`.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import type { Codec } from '../codec/codec.js';
import { isNoRowError } from '../codec/define-codec.js';
import { type AgentAdaptorOptions, createAgentAdaptor } from './agent-adaptor.js';
import type { EventWriterResult, WriterHandoff } from './event-writer.js';
import { prepareHeaders } from './headers.js';
import type { ChannelWriter } from './message-stream.js';

/**
 * The `type` the relay reads off an error that `write` throws to have it skip
 * that one event, log it and count it, rather than fail the route. The relay's
 * `unsupportedRelayEvent()` makes such an error; this package carries the type
 * on an `Ably.ErrorInfo` instead, since it has no Temporal dependency.
 */
const RELAY_UNSUPPORTED_EVENT_TYPE = 'AblyRelayUnsupportedEvent';

/**
 * The error `write` throws for an event of a type the codec has no row for,
 * which the relay skips.
 * @param cause - The codec's error.
 * @returns The error, an `InvalidArgument` that carries the relay's `type`.
 */
const unsupportedEvent = (cause: Ably.ErrorInfo): Ably.ErrorInfo & { type: string } =>
  Object.assign(new Ably.ErrorInfo(cause.message, ErrorCode.InvalidArgument, 400, cause), {
    type: RELAY_UNSUPPORTED_EVENT_TYPE,
  });

/** A JSON value, as the relay requires of a handoff, since it stores one in Temporal workflow history. */
export type RelayJsonValue = string | number | boolean | null | RelayJsonValue[] | { [key: string]: RelayJsonValue };

/**
 * An event the relay read from a Workflow Stream. The adaptor writes its
 * `data` and reads nothing else.
 * @template E - The codec's event union.
 */
export interface RelayEvent<E> {
  /** The Workflow Stream topic the event was published to. */
  topic: string;
  /** The event's offset in the Workflow Stream. */
  offset: number;
  /**
   * The event, as the source workflow published it, decoded by the worker's
   * payload converter. The relay does not check it against `E`; the codec
   * does, when the adaptor writes it.
   */
  data: E;
}

/** What a {@link RelayAdaptor}'s `flush` and `close` resolve with. */
export interface RelayAdaptorResult {
  /**
   * The streams left open, for the relay to store with its checkpoint and pass
   * to the factory of the next attempt, or `null` when none is open. It names
   * each stream's key and message serial, and holds no event content.
   */
  handoff: RelayJsonValue | null;
}

/**
 * Writes one relay route's events on one channel, through a codec, for one
 * activity attempt. It is an event writer: see `EventWriter` for how each
 * call behaves.
 * @template E - The codec's event union.
 */
export interface RelayAdaptor<E> {
  /**
   * Hand the event's `data` to the event writer. Returns without waiting for
   * the channel.
   * @param event - The event the relay read.
   * @throws {Ably.ErrorInfo} As `EventWriter.write`: `InvalidArgument` when the codec cannot write the event, which the relay treats as a failure it does not retry; after the writer stopped, the error that stopped it. For an event of a type the codec has no row for, such as one from a producer newer than the codec, the `InvalidArgument` also carries `type: 'AblyRelayUnsupportedEvent'`, which asks the relay to skip that one event, log it and count it, and carry on.
   */
  write(event: RelayEvent<E>): void;
  /**
   * Wait until every event written so far is on the channel, keeping open
   * streams open, as `EventWriter.flush` does.
   * @returns The handoff for this point.
   * @throws {Ably.ErrorInfo} As `EventWriter.flush`.
   */
  flush(): Promise<RelayAdaptorResult>;
  /**
   * Wait until every event written is on the channel and stop the writer, as
   * `EventWriter.close` does. It ends no stream: a stream the route's events
   * never ended stays open on every decoder.
   * @returns The handoff for this point.
   * @throws {Ably.ErrorInfo} As `EventWriter.close`.
   */
  close(): Promise<RelayAdaptorResult>;
  /**
   * Stop the writer at once, as `EventWriter.abort` does: drop the events not
   * yet written, wait for no ack, repair nothing and end no stream, so the
   * retry that adopts the last checkpoint's handoff is the only writer on
   * those messages. Never throws, and a second call does nothing.
   */
  abort(): void;
}

/**
 * Creates the {@link RelayAdaptor} for one activity attempt of a route.
 * Register it in the `adaptors` option of the relay's worker plugin.
 * @template E - The codec's event union.
 * @param channel - The route's channel, which the relay gives out from its channel pool. It must have `getMessage` for the attempt to adopt a stream left open.
 * @param handoff - The handoff of the route's last checkpoint, or `null` when the route starts.
 * @returns The adaptor.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the handoff is not one a relay adaptor returned, or names a stream and the channel has no `getMessage`.
 */
export type RelayAdaptorFactory<E> = (channel: ChannelWriter, handoff: RelayJsonValue | null) => RelayAdaptor<E>;

/**
 * The relay's form of a writer's result: the handoff as plain JSON, or `null`
 * when no stream is open, which keeps the checkpoint small.
 * @param result - What the writer's flush or close resolved with.
 * @returns The relay's result.
 */
const toRelayResult = (result: EventWriterResult): RelayAdaptorResult => {
  const { streams } = result.handoff;
  return streams.length === 0
    ? // eslint-disable-next-line unicorn/no-null -- the relay's contract names null as the handoff that carries nothing
      { handoff: null }
    : { handoff: { streams: streams.map(({ key, serial }) => ({ key, serial })) } };
};

/**
 * Create a relay adaptor factory over a codec, for a route whose Workflow
 * Stream topics carry the codec's events, as a workflow or its activities
 * publish them. Each attempt opens an event writer on the
 * channel the relay gives it, or adopts the last checkpoint's handoff, so a
 * stream carries on in the same message across checkpoints and retries.
 * @template E - The codec's event union.
 * @param codec - The codec that turns events into Ably messages.
 * @param options - The logger, and headers for every message the adaptor publishes, as for an agent adaptor.
 * @returns The factory.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null.
 */
export const createRelayAdaptor = <E>(codec: Codec<E>, options: AgentAdaptorOptions = {}): RelayAdaptorFactory<E> =>
  createMappedRelayAdaptor(codec, options, (data: E) => data);

/**
 * Create a relay adaptor factory that turns each event's `data` into the
 * codec's event before writing it, for a producer whose Workflow Stream
 * carries something other than the codec's events.
 * @template D - What the relay's events carry as `data`.
 * @template E - The codec's event union.
 * @param codec - The codec that turns events into Ably messages.
 * @param options - As for {@link createRelayAdaptor}.
 * @param toEvent - Turns an event's `data` into the codec's event, or into `undefined` for one with nothing to write, which the adaptor skips. Whatever it throws, `write` throws, and an error from the codec's `noRowError` as the relay's unsupported event.
 * @returns The factory.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a header value is not a string, number, boolean or null.
 */
export const createMappedRelayAdaptor = <D, E>(
  codec: Codec<E>,
  options: AgentAdaptorOptions,
  toEvent: (data: D) => E | undefined,
): RelayAdaptorFactory<D> => {
  // Checked here, so a bad header fails when the worker registers the factory
  // rather than on the route's first attempt.
  prepareHeaders(options.headers, 'create relay adaptor');
  const logger: Logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
    component: 'RelayAdaptor',
    codec: codec.id,
  });

  return (channel, handoff) => {
    logger.trace('RelayAdaptor();', { adopting: handoff !== null });
    const adaptor = createAgentAdaptor(channel, codec, { ...options, logger });
    // CAST: the handoff is JSON read back from workflow history, which no type
    // narrows to a WriterHandoff; adoptWriter checks its shape before use.
    const writer = handoff === null ? adaptor.newWriter() : adaptor.adoptWriter(handoff as unknown as WriterHandoff);
    return {
      write: ({ topic, offset, data }) => {
        try {
          const event = toEvent(data);
          if (event === undefined) {
            logger.debug('RelayAdaptor.write(); nothing to write for the event', { topic, offset });
            return;
          }
          writer.write(event);
        } catch (error) {
          throw isNoRowError(error) ? unsupportedEvent(error) : error;
        }
      },
      flush: async () => toRelayResult(await writer.flush()),
      close: async () => toRelayResult(await writer.close()),
      abort: () => {
        writer.abort();
      },
    };
  };
};
