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
