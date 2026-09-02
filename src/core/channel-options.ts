/**
 * Channel-mode resolution for AI Transport channels.
 *
 * Presence, pub/sub, and annotation publishing are all part of the server's
 * default channel-mode set, so a channel attached with no mode flags is granted
 * them automatically. LiveObjects is different: object operations require the
 * `object_subscribe` / `object_publish` modes, which are NOT in the default
 * set, so the channel must be attached with explicit modes to use them.
 *
 * Setting `modes` on the wire is a full replacement, not additive: the moment
 * an ATTACH carries any mode flag the server takes that bitfield verbatim and
 * never falls back to its default set. So requesting object modes means also
 * requesting everything the default set would grant, plus the object modes.
 * `AIT_BASE_MODES` is exactly the server default, so opting into extra
 * modes adds the extras and changes nothing else.
 *
 * Every place that resolves channel options for an AI Transport channel — the
 * React `<ClientTransportProvider>` and the ably-js `<ChannelProvider>` it
 * renders — must funnel through {@link resolveChannelModes} so they all
 * request the SAME modes in the SAME order. ably-js compares modes order- and duplicate-sensitively when deciding
 * whether a `setOptions` call needs a reattach; identical arrays compare equal,
 * so consistent resolution avoids both spurious reattaches and silent mode
 * reversion when one writer omits modes another set.
 */

import type * as Ably from 'ably';

/**
 * The modes AI Transport always needs — byte-for-byte the server's default
 * channel-mode set (`PUBLISH | SUBSCRIBE | PRESENCE | PRESENCE_SUBSCRIBE |
 * ANNOTATION_PUBLISH`). Because this equals the default, requesting it plus
 * extra modes (e.g. {@link OBJECT_MODES}) grants the same access as the default
 * set plus those extras.
 */
const AIT_BASE_MODES: readonly Ably.ChannelMode[] = [
  'PUBLISH',
  'SUBSCRIBE',
  'PRESENCE',
  'PRESENCE_SUBSCRIBE',
  'ANNOTATION_PUBLISH',
];

/**
 * The channel modes required to read and write Ably LiveObjects. Pass as the
 * `channelModes` prop of `<ClientTransportProvider>`
 * (`channelModes: OBJECT_MODES`) to request object access on the transport's
 * channel, enabling the LiveObjects channel hooks under the provider.
 */
export const OBJECT_MODES: readonly Ably.ChannelMode[] = ['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH'];

/**
 * Canonical ordering for every known channel mode. {@link resolveChannelModes}
 * emits modes in this order so two resolutions of the same mode set produce
 * identical arrays, which ably-js treats as equal (no reattach churn).
 */
const MODE_ORDER: readonly Ably.ChannelMode[] = [
  'PUBLISH',
  'SUBSCRIBE',
  'PRESENCE',
  'PRESENCE_SUBSCRIBE',
  'OBJECT_PUBLISH',
  'OBJECT_SUBSCRIBE',
  'ANNOTATION_PUBLISH',
  'ANNOTATION_SUBSCRIBE',
];

/**
 * Resolve the channel modes AI Transport should request on its channel.
 *
 * Returns `undefined` when the caller asks for no extra modes, so the channel
 * attaches with no mode flags and the server applies its default set. When
 * extra modes are supplied (e.g. {@link OBJECT_MODES}), returns the server
 * default set — PUBLISH, SUBSCRIBE, PRESENCE, PRESENCE_SUBSCRIBE and
 * ANNOTATION_PUBLISH — unioned with them, de-duplicated and in a fixed
 * canonical order so repeated resolutions compare equal.
 *
 * A mode outside that canonical order (which should not occur for a valid
 * {@link Ably.ChannelMode}, but is possible with the type's lowercase aliases)
 * is appended after the canonical ones, sorted alphabetically, so the result
 * is still deterministic.
 * @param extraModes - Modes to request on top of the server default set. Omit or pass an empty array to request no modes at all.
 * @returns The canonically-ordered, de-duplicated mode set, or `undefined` when no extra modes were requested.
 */
export const resolveChannelModes = (extraModes?: readonly Ably.ChannelMode[]): Ably.ChannelMode[] | undefined => {
  if (extraModes === undefined || extraModes.length === 0) return undefined;
  const requested = new Set<Ably.ChannelMode>([...AIT_BASE_MODES, ...extraModes]);
  const ordered = MODE_ORDER.filter((mode) => requested.has(mode));
  const unknown = [...requested].filter((mode) => !MODE_ORDER.includes(mode)).toSorted();
  return [...ordered, ...unknown];
};
