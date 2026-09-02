/**
 * Channel-mode constants for AI Transport channels.
 *
 * A transport is handed a channel the caller already resolved, so the caller
 * chooses the modes. These constants tell it which ones to ask for.
 *
 * Presence, pub/sub, and annotation publishing are all part of the server's
 * default channel-mode set, so a channel attached with no mode flags is granted
 * them automatically. LiveObjects is different: object operations require the
 * `object_subscribe` / `object_publish` modes, which are NOT in the default
 * set, so the channel must be attached with explicit modes to use them.
 *
 * Setting `modes` on the wire is a full replacement, not additive: the moment
 * an ATTACH carries any mode flag the server takes that bitfield verbatim and
 * never falls back to its default set. So a caller requesting object modes must
 * also request everything the default set would grant. {@link AIT_BASE_MODES}
 * is exactly the server default, so `[...AIT_BASE_MODES, ...OBJECT_MODES]`
 * adds the object modes and changes nothing else.
 *
 * Resolve the modes once and pass the same array everywhere the channel is
 * configured. ably-js compares modes order- and duplicate-sensitively when
 * deciding whether a `setOptions` call needs a reattach, so one array reused
 * avoids both spurious reattaches and silent mode reversion when one writer
 * omits modes another set.
 */

import type * as Ably from 'ably';

/**
 * The modes AI Transport always needs — byte-for-byte the server's default
 * channel-mode set (`PUBLISH | SUBSCRIBE | PRESENCE | PRESENCE_SUBSCRIBE |
 * ANNOTATION_PUBLISH`). Because this equals the default, requesting it plus
 * extra modes (e.g. {@link OBJECT_MODES}) grants the same access as the default
 * set plus those extras.
 */
export const AIT_BASE_MODES: readonly Ably.ChannelMode[] = [
  'PUBLISH',
  'SUBSCRIBE',
  'PRESENCE',
  'PRESENCE_SUBSCRIBE',
  'ANNOTATION_PUBLISH',
];

/**
 * The channel modes required to read and write Ably LiveObjects. Attach the
 * transport's channel with `[...AIT_BASE_MODES, ...OBJECT_MODES]` to request
 * object access alongside everything the server default would have granted.
 */
export const OBJECT_MODES: readonly Ably.ChannelMode[] = ['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH'];
