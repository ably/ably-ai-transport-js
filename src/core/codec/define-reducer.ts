/**
 * `defineReducer` — the shared reducer spine.
 *
 * Both hand-written codec reducers (Vercel, OpenAI) fold their events into the
 * same shape of per-node projection: an entry list keyed by codec-message-id,
 * a per-entry tracker for streamed-part bookkeeping, and an optional
 * projection-level state object for out-of-order state. `defineReducer` owns that shape
 * and the parts of the fold that are identical across codecs — the entry
 * store, the direction/drop dispatch, the well-known `user-message` and
 * `regenerate` routing, and `getMessages` — and delegates the codec-specific
 * fold bodies through a small set of hooks.
 *
 * A codec supplies `createEntry` / `foldOutput` / `foldUserMessage` (required)
 * and, when it carries out-of-order state, `initExtra` / `foldInput` /
 * `afterFold` (optional). `getMessages` maps entries through an optional
 * `toMessage` transform (used by OpenAI's positional compaction); with no
 * transform it returns the entry-message list by reference.
 *
 * The result is the `{ init, fold, getMessages }` triple a codec drops into
 * {@link defineCodec}'s `reducer` slot.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { CodecReducer } from './define-codec.js';
import type { CodecEvent, CodecInputEvent, CodecMessage, CodecOutputEvent, ReducerMeta, UserMessage } from './types.js';

// ---------------------------------------------------------------------------
// Projection + entry shapes
// ---------------------------------------------------------------------------

/**
 * The per-node projection the spine owns and folds events into. `messages`
 * holds the reconstructed domain messages paired with their codec-message-ids
 * (returned verbatim by the identity `getMessages`); `trackers` holds each
 * entry's codec-owned streamed-part tracker keyed by the same
 * codec-message-id; `extra` is the codec's optional projection-level state
 * object (seeded by `initExtra`, `undefined` when the codec omits it).
 *
 * The two are kept separate so the identity `getMessages` can return
 * `messages` by reference without a per-entry tracker leaking into the
 * application-facing output.
 * @template TMessage - The codec's per-message domain type.
 * @template TTracker - The codec's per-entry tracker type.
 * @template TExtra - The codec's projection-level state object, or `undefined`.
 */
export interface ReducerProjection<TMessage, TTracker, TExtra> {
  /** Reconstructed messages, each paired with its codec-message-id. */
  messages: CodecMessage<TMessage>[];
  /** Per-entry streamed-part trackers, keyed by codec-message-id. */
  trackers: Map<string, TTracker>;
  /** The codec's projection-level state object, seeded by `initExtra` (or `undefined`). */
  extra: TExtra;
}

/**
 * An entry handed to a fold body: the reconstructed message and its tracker
 * for one codec-message-id, resolved together. `message` and `tracker` are the
 * same references the projection stores, so a fold body mutates them in place.
 * @template TMessage - The codec's per-message domain type.
 * @template TTracker - The codec's per-entry tracker type.
 */
export interface ReducerEntry<TMessage, TTracker> {
  /** The codec-message-id this entry is keyed on. */
  readonly codecMessageId: string;
  /** The reconstructed message; mutate in place to fold new content. */
  message: TMessage;
  /** The codec's per-entry tracker; mutate in place to record stream state. */
  tracker: TTracker;
}

// ---------------------------------------------------------------------------
// Fold-body capability object
// ---------------------------------------------------------------------------

/**
 * The capability object handed to every fold body (`foldOutput`,
 * `foldUserMessage`, `foldInput`, `afterFold`). One uniform shape for all
 * hooks; a hook ignores the capabilities it does not need.
 *
 * `lookup` / `ensure` default to the current event's codec-message-id; `lookup`
 * also accepts an explicit id so a fold body can target another entry (the
 * tool-resolution buffer targets the assistant named by the resolution, not
 * the current event). `entries` exposes every resolved entry for the rare
 * projection-wide scan (Vercel's tool-output owner lookup). `extra` is the
 * codec's projection state object.
 * @template TMessage - The codec's per-message domain type.
 * @template TTracker - The codec's per-entry tracker type.
 * @template TExtra - The codec's projection-level state object, or `undefined`.
 * @template TRole - The message-role literal `createEntry` accepts.
 */
export interface ReducerCtx<TMessage, TTracker, TExtra, TRole extends string> {
  /**
   * Resolve an existing entry by codec-message-id, defaulting to the current
   * event's. Returns `undefined` when no entry exists for that id — a fold
   * body treats a miss as a no-op rather than creating an empty entry.
   * @param codecMessageId - The id to resolve; defaults to the current event's.
   */
  lookup(codecMessageId?: string): ReducerEntry<TMessage, TTracker> | undefined;
  /**
   * Resolve the current event's entry, creating it if absent. On create the
   * entry's tracker comes from `createEntry(role)`; its message is the
   * supplied `seed` when present (the user path stores the incoming aggregate
   * verbatim), otherwise `createEntry(role)`'s message.
   * @param role - The message role passed to `createEntry` on create.
   * @param seed - The verbatim message to store on create, if the codec has one.
   */
  ensure(role: TRole, seed?: TMessage): ReducerEntry<TMessage, TTracker>;
  /** Every resolved entry, for a projection-wide scan. */
  entries(): ReducerEntry<TMessage, TTracker>[];
  /** The codec's projection-level state object (seeded by `initExtra`). */
  extra: TExtra;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The parts a codec supplies to {@link defineReducer}. The three required
 * hooks cover every codec; the three optional hooks host a codec's
 * out-of-order state (Vercel's tool-resolution buffer). `toMessage` is
 * supplied only by a codec whose `getMessages` transforms the stored message
 * (OpenAI's positional-hole compaction).
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TMessage - The codec's per-message domain type.
 * @template TTracker - The codec's per-entry tracker type.
 * @template TExtra - The codec's projection-level state object, or `undefined`.
 * @template TRole - The message-role literal `createEntry` accepts.
 */
export interface DefineReducerConfig<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TMessage,
  TTracker,
  TExtra,
  TRole extends string,
> {
  /**
   * Seed a fresh entry for a role: an empty message and its tracker. Called on
   * the `ensure` create path (its message is discarded when a `seed` is
   * supplied). The `codecMessageId` is the id the entry will be keyed on, so a
   * codec whose message carries an identity can seed it as the fallback (Vercel
   * stamps it on `UIMessage.id`); a codec whose message has no id ignores it.
   * Only ever invoked with the roles a codec's fold bodies pass.
   * @param role - The message role to seed.
   * @param codecMessageId - The id the created entry is keyed on.
   */
  createEntry(role: TRole, codecMessageId: string): { message: TMessage; tracker: TTracker };
  /**
   * Fold one output event into the projection via `ctx`.
   * @param ctx - The fold-body capability object.
   * @param event - The output event.
   * @param meta - Transport-derived metadata (serial + codec-message-id).
   */
  foldOutput(ctx: ReducerCtx<TMessage, TTracker, TExtra, TRole>, event: TOutput, meta: ReducerMeta): void;
  /**
   * Fold a well-known `user-message` input's message into the projection.
   * @param ctx - The fold-body capability object.
   * @param message - The user's message in the codec's domain representation.
   * @param meta - Transport-derived metadata (serial + codec-message-id).
   */
  foldUserMessage(ctx: ReducerCtx<TMessage, TTracker, TExtra, TRole>, message: TMessage, meta: ReducerMeta): void;
  /**
   * Seed the projection's `extra` state object. Required when `foldInput` or
   * `afterFold` is supplied (they read `extra`); omit for a codec with no
   * projection-level state.
   */
  initExtra?(): TExtra;
  /**
   * Fold an input event other than the well-known `user-message` /
   * `regenerate`. Receives the full input union; a supplied `foldInput` owns
   * exhaustiveness and must throw on a kind it does not model (a `default`
   * arm), mirroring the spine's own throw for the no-`foldInput` case.
   * @param ctx - The fold-body capability object.
   * @param event - The input event.
   * @param meta - Transport-derived metadata (serial + codec-message-id).
   */
  foldInput?(ctx: ReducerCtx<TMessage, TTracker, TExtra, TRole>, event: TInput, meta: ReducerMeta): void;
  /**
   * Run after every real fold body (not after a dropped-no-cmid event or the
   * `regenerate` no-op). Hosts the tool-resolution buffer's retry.
   * @param ctx - The fold-body capability object.
   */
  afterFold?(ctx: ReducerCtx<TMessage, TTracker, TExtra, TRole>): void;
  /**
   * Transform a stored message on the way out of `getMessages`. Defaults to
   * identity (the stored message is returned by reference). Supplied by a
   * codec whose extraction differs from storage (OpenAI compacts positional
   * holes). Receives the stored message; no codec's transform needs the
   * tracker, so the entry is not passed. Declared as a property (not a method)
   * so `getMessages` can hoist it into a local without tripping the
   * unbound-method lint.
   * @param message - The stored message.
   */
  toMessage?: (message: TMessage) => TMessage;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Assemble the `{ init, fold, getMessages }` reducer triple from a codec's
 * parts. Type parameters are explicit at the call site (the input/output
 * unions cannot be inferred); `TExtra` defaults to `undefined` for a codec
 * with no projection-level state object.
 *
 * Validates at definition: a codec that supplies `foldInput` or `afterFold`
 * must also supply `initExtra`, so a hook can never read an `extra` the codec
 * never seeded.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TMessage - The codec's per-message domain type.
 * @template TTracker - The codec's per-entry tracker type.
 * @template TRole - The message-role literal `createEntry` accepts.
 * @template TExtra - The codec's projection-level state object, or `undefined`.
 * @param config - The codec's supplied reducer parts.
 * @returns The reducer triple for {@link defineCodec}'s `reducer` slot.
 */
export const defineReducer = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TMessage,
  TTracker,
  TRole extends string,
  TExtra = undefined,
>(
  config: DefineReducerConfig<TInput, TOutput, TMessage, TTracker, TExtra, TRole>,
): CodecReducer<TInput, TOutput, ReducerProjection<TMessage, TTracker, TExtra>, TMessage> => {
  // Build-time guard: a hook that reads `extra` requires `initExtra` to seed it.
  if ((config.foldInput !== undefined || config.afterFold !== undefined) && config.initExtra === undefined) {
    throw new Ably.ErrorInfo(
      'unable to define reducer; foldInput/afterFold require initExtra to seed the extra state object',
      ErrorCode.InvalidArgument,
      400,
    );
  }

  type Projection = ReducerProjection<TMessage, TTracker, TExtra>;
  type Entry = ReducerEntry<TMessage, TTracker>;

  const init = (): Projection => ({
    messages: [],
    trackers: new Map<string, TTracker>(),
    // No initExtra means the codec never reads `extra`; `undefined` is the
    // TExtra default in that case.
    extra: (config.initExtra === undefined ? undefined : config.initExtra()) as TExtra,
  });

  const resolve = (state: Projection, codecMessageId: string): Entry | undefined => {
    const cm = state.messages.find((e) => e.codecMessageId === codecMessageId);
    if (cm === undefined) return undefined;
    const tracker = state.trackers.get(codecMessageId);
    // A message entry is only ever created alongside its tracker (via
    // `ensure`), so a present message implies a present tracker; the guard
    // also narrows `TTracker | undefined` to `TTracker` without a cast.
    if (tracker === undefined) return undefined;
    return { codecMessageId, message: cm.message, tracker };
  };

  const makeCtx = (state: Projection, currentCmid: string): ReducerCtx<TMessage, TTracker, TExtra, TRole> => ({
    lookup: (codecMessageId) => resolve(state, codecMessageId ?? currentCmid),
    ensure: (role, seed) => {
      const existing = resolve(state, currentCmid);
      if (existing !== undefined) return existing;
      const created = config.createEntry(role, currentCmid);
      const message = seed === undefined ? created.message : seed;
      state.messages.push({ codecMessageId: currentCmid, message });
      state.trackers.set(currentCmid, created.tracker);
      return { codecMessageId: currentCmid, message, tracker: created.tracker };
    },
    entries: () => {
      const out: Entry[] = [];
      for (const cm of state.messages) {
        const entry = resolve(state, cm.codecMessageId);
        if (entry !== undefined) out.push(entry);
      }
      return out;
    },
    extra: state.extra,
  });

  const fold = (state: Projection, codecEvent: CodecEvent<TInput, TOutput>, meta: ReducerMeta): Projection => {
    // No codec-message-id means no entry identity to key on; drop before any
    // fold body runs. Both codecs guard this way today.
    if (meta.messageId === undefined) return state;

    const ctx = makeCtx(state, meta.messageId);
    let folded = false;

    if (codecEvent.direction === 'output') {
      config.foldOutput(ctx, codecEvent.event, meta);
      folded = true;
    } else {
      const input = codecEvent.event;
      if (input.kind === 'user-message') {
        // CAST: the generic TInput cannot be narrowed by the `kind` literal, but
        // a 'user-message' kind is by contract the well-known UserMessage
        // variant whose `message` is the codec's TMessage.
        config.foldUserMessage(ctx, (input as unknown as UserMessage<TMessage>).message, meta);
        folded = true;
      } else if (input.kind === 'regenerate') {
        // Hardcoded no-op: a wire-lifecycle signal, not a fold. No codec hook.
      } else {
        if (config.foldInput === undefined) {
          throw new Ably.ErrorInfo(
            `unable to fold input; codec declares no foldInput for kind '${input.kind}'`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        config.foldInput(ctx, input, meta);
        folded = true;
      }
    }

    // afterFold runs only after a real fold body — not on a dropped event or
    // the regenerate no-op, which leave the stash nothing new to retry against.
    if (folded) config.afterFold?.(ctx);
    return state;
  };

  const getMessages = (state: Projection): CodecMessage<TMessage>[] => {
    // Identity: return the stored list by reference — no per-entry allocation.
    if (config.toMessage === undefined) return state.messages;
    const transform = config.toMessage;
    return state.messages.map((cm) => ({ codecMessageId: cm.codecMessageId, message: transform(cm.message) }));
  };

  return { init, fold, getMessages };
};
