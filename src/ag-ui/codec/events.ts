/**
 * The AG-UI codec's event union.
 *
 * The union is AG-UI's own events, as `@ag-ui/core` declares them. One event
 * of the codec's own joins them: `run-input`, the input a client publishes to
 * start a run, so both directions of a conversation share one codec.
 */

import type * as AGUI from '@ag-ui/core';

/**
 * The input a client publishes to start a run. AG-UI sends `RunAgentInput` as
 * an HTTP POST body, so the protocol does not define an event for it.
 */
export interface AGUIRunInput {
  /** Discriminator, distinct from every AG-UI event type. */
  type: 'run-input';
  /**
   * The run's input, carried as the Ably message's `data` as given. Its
   * `messages` travel whole, so a client should send only the messages the run
   * adds, and keep the rest of the conversation in its own store.
   */
  input: AGUI.RunAgentInput;
}

/** Every event the AG-UI codec encodes and decodes. */
export type AGUIEvent = AGUI.Event | AGUIRunInput;

/**
 * The type of every event in {@link AGUIEvent}, as plain strings. AG-UI
 * declares its types as a string enum, and the template literal widens each
 * member to the string it holds. The row table's keys are those strings.
 */
export type AGUIEventType = `${AGUIEvent['type']}`;
