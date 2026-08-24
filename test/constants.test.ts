/**
 * Wire-value pins for the transport headers and message names.
 *
 * Everything else in the suite reaches the wire through these constants on
 * both the write and the read side, so a renamed, typo'd or half-renamed value
 * would leave every other test passing while breaking every peer on the old
 * name. This file is the one place that asserts the literal strings.
 *
 * Changing a value here is a protocol break: peers must run the same version.
 */

import { describe, expect, it } from 'vitest';

import {
  EVENT_AI_INPUT,
  EVENT_AI_OUTPUT,
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_DISCRETE,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_EVENT_ID,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_ID,
  HEADER_INPUT_TRANSPORT_MESSAGE_IDS,
  HEADER_INVOCATION_ID,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STATUS,
  HEADER_STEER_TRANSPORT_MESSAGE_IDS,
  HEADER_STEP_CLIENT_ID,
  HEADER_STEP_ID,
  HEADER_STEP_REASON,
  HEADER_STEP_START_SERIAL,
  HEADER_STREAM,
  HEADER_STREAM_ID,
  HEADER_TRANSPORT_MESSAGE_ID,
} from '../src/constants.js';

describe('wire values', () => {
  it('pins every transport header string', () => {
    expect({
      HEADER_STREAM,
      HEADER_STATUS,
      HEADER_STREAM_ID,
      HEADER_DISCRETE,
      HEADER_RUN_ID,
      HEADER_INVOCATION_ID,
      HEADER_EVENT_ID,
      HEADER_TRANSPORT_MESSAGE_ID,
      HEADER_RUN_CLIENT_ID,
      HEADER_INPUT_CLIENT_ID,
      HEADER_ROLE,
      HEADER_RUN_REASON,
      HEADER_STEP_ID,
      HEADER_STEP_START_SERIAL,
      HEADER_STEP_REASON,
      HEADER_STEP_CLIENT_ID,
      HEADER_INPUT_TRANSPORT_MESSAGE_ID,
      HEADER_STEER_TRANSPORT_MESSAGE_IDS,
      HEADER_INPUT_TRANSPORT_MESSAGE_IDS,
      HEADER_ERROR_CODE,
      HEADER_ERROR_MESSAGE,
    }).toEqual({
      HEADER_STREAM: 'stream',
      HEADER_STATUS: 'status',
      HEADER_STREAM_ID: 'stream-id',
      HEADER_DISCRETE: 'discrete',
      HEADER_RUN_ID: 'run-id',
      HEADER_INVOCATION_ID: 'invocation-id',
      HEADER_EVENT_ID: 'event-id',
      HEADER_TRANSPORT_MESSAGE_ID: 'transport-message-id',
      HEADER_RUN_CLIENT_ID: 'run-client-id',
      HEADER_INPUT_CLIENT_ID: 'input-client-id',
      HEADER_ROLE: 'role',
      HEADER_RUN_REASON: 'run-reason',
      HEADER_STEP_ID: 'step-id',
      HEADER_STEP_START_SERIAL: 'step-start-serial',
      HEADER_STEP_REASON: 'step-reason',
      HEADER_STEP_CLIENT_ID: 'step-client-id',
      HEADER_INPUT_TRANSPORT_MESSAGE_ID: 'input-transport-message-id',
      HEADER_STEER_TRANSPORT_MESSAGE_IDS: 'steer-transport-message-ids',
      HEADER_INPUT_TRANSPORT_MESSAGE_IDS: 'input-transport-message-ids',
      HEADER_ERROR_CODE: 'error-code',
      HEADER_ERROR_MESSAGE: 'error-message',
    });
  });

  it('pins every wire message name', () => {
    expect({
      EVENT_AI_INPUT,
      EVENT_AI_OUTPUT,
      EVENT_CANCEL,
      EVENT_RUN_START,
      EVENT_RUN_RESUME,
      EVENT_RUN_SUSPEND,
      EVENT_RUN_END,
      EVENT_STEP_START,
      EVENT_STEP_END,
    }).toEqual({
      EVENT_AI_INPUT: 'ai-input',
      EVENT_AI_OUTPUT: 'ai-output',
      EVENT_CANCEL: 'ai-cancel',
      EVENT_RUN_START: 'ai-run-start',
      EVENT_RUN_RESUME: 'ai-run-resume',
      EVENT_RUN_SUSPEND: 'ai-run-suspend',
      EVENT_RUN_END: 'ai-run-end',
      EVENT_STEP_START: 'ai-step-start',
      EVENT_STEP_END: 'ai-step-end',
    });
  });
});
