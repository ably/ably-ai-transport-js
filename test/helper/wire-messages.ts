/** Shared inbound wire-message builders for transport unit tests. */

import type * as Ably from 'ably';

import { HEADER_ROLE, HEADER_RUN_ID, HEADER_TRANSPORT_MESSAGE_ID } from '../../src/constants.js';

/** The fields {@link inboundMessage} projects onto its wire stub. */
export interface InboundMessageOptions {
  /** The wire name. */
  name?: string;
  /** The `extras.ai.transport` header bucket. */
  transport?: Record<string, string>;
  /** The `extras.ai.codec` header bucket. */
  codec?: Record<string, string>;
  /** The application's own `extras.headers` bucket, outside the ai envelope. */
  headers?: Record<string, string>;
  /** Overrides the whole `extras` object when present (use `undefined` for a message with no extras). */
  extras?: unknown;
  /** The channel serial. */
  serial?: string;
  /** The message timestamp. */
  timestamp?: number;
  /** The publisher's clientId. */
  clientId?: string;
  /** The `version.serial`. */
  versionSerial?: string;
  /** The `version.timestamp`. */
  versionTimestamp?: number;
}

/**
 * Build a minimal inbound wire stub carrying an `extras.ai` envelope (or the
 * verbatim `extras` override).
 * @param opts - The fields to project; everything omitted stays undefined.
 * @returns The wire message.
 */
export const inboundMessage = (opts: InboundMessageOptions): Ably.InboundMessage =>
  ({
    name: opts.name,
    action: 'message.create',
    clientId: opts.clientId,
    extras:
      'extras' in opts
        ? opts.extras
        : {
            ai: { transport: opts.transport ?? {}, codec: opts.codec ?? {} },
            ...(opts.headers && { headers: opts.headers }),
          },
    serial: opts.serial,
    timestamp: opts.timestamp,
    version: { serial: opts.versionSerial, timestamp: opts.versionTimestamp },
    // CAST: minimal InboundMessage stub — only the fields the receive tier reads.
  }) as unknown as Ably.InboundMessage;

/**
 * Build an inbound `ai-output` wire message.
 * @param serial - The channel serial.
 * @param text - The payload a name-aware test decoder surfaces as the output's `text`.
 * @param runId - The run-id transport header.
 * @returns The wire message.
 */
export const outputMsg = (serial: string, text: string, runId = 'R1'): Ably.InboundMessage =>
  // CAST: the transports read name/data/extras/serial/timestamp/version only.
  ({
    name: 'ai-output',
    action: 'message.create',
    data: text,
    extras: {
      ai: {
        transport: {
          [HEADER_RUN_ID]: runId,
          [HEADER_ROLE]: 'assistant',
          [HEADER_TRANSPORT_MESSAGE_ID]: `cmid-${text}`,
        },
      },
    },
    serial,
    timestamp: 1000,
    version: {},
  }) as unknown as Ably.InboundMessage;

/**
 * Build an inbound wire message a name-aware test decoder throws on (its name
 * is `boom`).
 * @param serial - The channel serial.
 * @returns The wire message.
 */
export const boomMsg = (serial: string): Ably.InboundMessage =>
  // CAST: see outputMsg.
  ({
    name: 'boom',
    action: 'message.create',
    extras: {},
    serial,
    timestamp: 1000,
    version: {},
  }) as unknown as Ably.InboundMessage;

/**
 * Build a foreign wire — an application's own publish on a channel it shares
 * with a transport. It carries no `extras.ai` envelope.
 * @returns The foreign InboundMessage.
 */
export const foreignWire = (): Ably.InboundMessage =>
  ({
    name: 'chat.message',
    action: 'message.create',
    serial: 'foreign-1',
    timestamp: 1000,
    version: { serial: 'foreign-1' },
    data: { text: 'hello from the app' },
    extras: { headers: { topic: 'support' } },
    // CAST: minimal InboundMessage stub — only the fields the classifier reads.
  }) as unknown as Ably.InboundMessage;
