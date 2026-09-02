/**
 * Build the transport-tier {@link WireMeta} for one inbound wire message.
 *
 * `WireMeta` is the metadata the receive stream surfaces alongside a decoded
 * message. It carries the two raw header tiers (`transport` and `codec`)
 * verbatim so any consumer rebuilds conversation state off
 * the public event with no privileged access to the wire, plus a typed
 * convenience projection of the transport tier's identity and structure fields.
 */

import type * as Ably from 'ably';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INPUT_CODEC_MESSAGE_IDS,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_STEER_CODEC_MESSAGE_IDS,
  HEADER_STEP_ID,
  HEADER_STEP_START_SERIAL,
} from '../../constants.js';
import { getCodecHeaders, getTransportHeaders, getUserHeaders } from '../../utils.js';
import { parseCodecMessageIdsHeader } from './headers.js';
import type { WireMeta } from './types/transport.js';

/**
 * Read one inbound Ably message into its {@link WireMeta}. Populates the raw
 * `transport` / `codec` header buckets verbatim, then projects the typed
 * convenience fields off the transport tier and the message's own Ably fields.
 * Never interprets the structure fields — it copies them through.
 * @param rawMsg - The inbound Ably wire message.
 * @returns The message's transport-tier metadata.
 */
export const wireMetaFromMessage = (rawMsg: Ably.InboundMessage): WireMeta => {
  const transport = getTransportHeaders(rawMsg);
  const codec = getCodecHeaders(rawMsg);
  return {
    transport,
    codec,
    headers: getUserHeaders(rawMsg),
    serial: rawMsg.serial,
    codecMessageId: transport[HEADER_CODEC_MESSAGE_ID],
    runId: transport[HEADER_RUN_ID],
    stepId: transport[HEADER_STEP_ID],
    stepStartSerial: transport[HEADER_STEP_START_SERIAL],
    timestamp: rawMsg.timestamp,
    role: transport[HEADER_ROLE],
    clientId: rawMsg.clientId,
    messageName: rawMsg.name,
    versionSerial: rawMsg.version.serial,
    versionTimestamp: rawMsg.version.timestamp,
    parent: transport[HEADER_PARENT],
    forkOf: transport[HEADER_FORK_OF],
    regenerates: transport[HEADER_MSG_REGENERATE],
    inputCodecMessageId: transport[HEADER_INPUT_CODEC_MESSAGE_ID],
    inputCodecMessageIds: parseCodecMessageIdsHeader(transport[HEADER_INPUT_CODEC_MESSAGE_IDS]),
    steerCodecMessageIds: parseCodecMessageIdsHeader(transport[HEADER_STEER_CODEC_MESSAGE_IDS]),
  };
};

/**
 * Build the {@link WireMeta} for an optimistic local echo — a message the client
 * emits for its own input before the wire round-trips. There is no inbound Ably
 * message yet, so the wire-assigned fields (`serial`, `timestamp`,
 * `versionSerial`, `versionTimestamp`, `messageName`) are all `undefined`; the
 * real echo later carries the same `codecMessageId` for a consumer to reconcile
 * on. The typed fields project off the transport headers the client stamped, so
 * a local echo and its wire counterpart surface identical identity and structure.
 * @param transport - The transport-tier headers the client stamped on the input.
 * @param clientId - The publishing client's Ably `clientId`, or `undefined` when anonymous.
 * @param headers - The user headers the publish will stamp into Ably's
 *   `extras.headers` slot, so the echo carries the same headers its wire
 *   counterpart will. Empty object when the publish stamps none.
 * @returns The local echo's transport-tier metadata.
 */
export const wireMetaFromLocalEcho = (
  transport: Record<string, string>,
  clientId: string | undefined,
  headers: Record<string, string>,
): WireMeta => ({
  transport,
  codec: {},
  headers,
  serial: undefined,
  codecMessageId: transport[HEADER_CODEC_MESSAGE_ID],
  runId: transport[HEADER_RUN_ID],
  stepId: transport[HEADER_STEP_ID],
  stepStartSerial: transport[HEADER_STEP_START_SERIAL],
  timestamp: undefined,
  role: transport[HEADER_ROLE],
  clientId,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  parent: transport[HEADER_PARENT],
  forkOf: transport[HEADER_FORK_OF],
  regenerates: transport[HEADER_MSG_REGENERATE],
  inputCodecMessageId: transport[HEADER_INPUT_CODEC_MESSAGE_ID],
  inputCodecMessageIds: parseCodecMessageIdsHeader(transport[HEADER_INPUT_CODEC_MESSAGE_IDS]),
  steerCodecMessageIds: parseCodecMessageIdsHeader(transport[HEADER_STEER_CODEC_MESSAGE_IDS]),
});
