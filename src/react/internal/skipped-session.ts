/**
 * The stub {@link ClientSession} returned by the context-reader hooks when they
 * are skipped, when no provider is found, or when session construction failed.
 * Every member throws so a held-but-unusable session fails loudly rather than
 * silently no-ops. Generic so each consumer gets a session typed to its own
 * codec parameters without a cast — the throwing bodies satisfy any instantiation.
 */

import * as Ably from 'ably';
import type * as AblyObjects from 'ably/liveobjects';

import type { CodecInputEvent, CodecOutputEvent } from '../../core/codec/types.js';
import type { ClientSession, ClientView, Tree } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';

/**
 * Build the `hook is skipped` error for a stub member.
 * @param operation - The attempted operation, phrased for the `unable to <operation>; hook is skipped` message.
 * @returns The skipped-hook error.
 */
const skipped = (operation: string): Ably.ErrorInfo =>
  new Ably.ErrorInfo(`unable to ${operation}; hook is skipped`, ErrorCode.InvalidArgument, 400);

/**
 * Create a throwing stub {@link ClientSession}. Held safely in state before a
 * provider resolves; any access throws {@link Ably.ErrorInfo}.
 * @returns A stub session whose every member throws.
 */
export const makeSkippedClientSession = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(): ClientSession<TInput, TOutput, TProjection, TMessage> => ({
  get tree(): Tree<TOutput, TProjection> {
    throw skipped('access tree');
  },
  get view(): ClientView<TInput, TMessage> {
    throw skipped('access view');
  },
  get presence(): Ably.RealtimePresence {
    throw skipped('access presence');
  },
  get object(): AblyObjects.RealtimeObject {
    throw skipped('access object');
  },
  connect: () => {
    throw skipped('connect');
  },
  createView: (): ClientView<TInput, TMessage> => {
    throw skipped('create view');
  },
  cancel: () => {
    throw skipped('cancel');
  },
  on: () => {
    throw skipped('subscribe');
  },
  close: () => {
    throw skipped('close');
  },
});
