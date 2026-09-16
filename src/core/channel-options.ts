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
 * The transport is the one place that resolves a channel, and it funnels the
 * caller's `channelModes` through {@link resolveChannelModes}, so every
 * transport on the same channel requests the SAME modes in the SAME order.
 *
 * ably-js compares modes order- and duplicate-sensitively when deciding whether
 * a `setOptions` call needs a reattach; identical arrays compare equal, so
 * consistent resolution avoids both spurious reattaches and silent mode
 * reversion when one writer omits modes another set.
 */

import type * as Ably from 'ably';

import { channelAgent } from './agent.js';

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
 * The channel modes required to read and write Ably LiveObjects.
 *
 * Pass it as `createTransport`'s `channelModes` option
 * (`channelModes: OBJECT_MODES`) to request object access on the transport's
 * channel, which is what the ably-js LiveObjects API on that channel needs.
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
 * @param extraModes - Modes to request on top of the server default set, as the transport's `channelModes` option supplies them. Omit or pass an empty array to request no modes at all.
 * @returns The canonically-ordered, de-duplicated mode set, or `undefined` when no extra modes were requested.
 */
export const resolveChannelModes = (extraModes?: readonly Ably.ChannelMode[]): Ably.ChannelMode[] | undefined => {
  if (extraModes === undefined || extraModes.length === 0) return undefined;
  const requested = new Set<Ably.ChannelMode>([...AIT_BASE_MODES, ...extraModes]);
  const ordered = MODE_ORDER.filter((mode) => requested.has(mode));
  const unknown = [...requested].filter((mode) => !MODE_ORDER.includes(mode)).toSorted();
  return [...ordered, ...unknown];
};

/**
 * The channel options a transport resolves its channel with.
 *
 * One function, because two callers must agree byte for byte: the transport
 * resolves the channel with these, and the React provider hands the same ones
 * to ably-js's `<ChannelProvider>`, whose layout effect calls `setOptions`
 * with whatever it was given. `setOptions` replaces a channel's options rather
 * than merging into them, so a provider that passed none would drop the
 * attribution, the echo param and the modes the transport asked for. ably-js
 * appends its own `react-hooks` agent to the one it is given, which is why the
 * agent survives that round trip.
 * @param options - What the options are built from.
 * @param options.codec - The codec whose tag joins the attribution string.
 * @param options.codec.adapterTag - The codec's attribution tag; appended when present.
 * @param options.channelModes - Modes to request on top of the server default set.
 * @param options.echoMessages - Whether the channel delivers this connection's own publishes back to it. Defaults to `true`, the platform default.
 * @returns The channel options.
 */
export const transportChannelOptions = (options: {
  codec: { readonly adapterTag?: string };
  channelModes?: readonly Ably.ChannelMode[];
  echoMessages?: boolean;
}): Ably.ChannelOptions => {
  const params: Ably.ChannelParams = { agent: channelAgent(options.codec) };
  // Ably delivers a connection's own publishes back to it, which is what an
  // application folding every delivery into one list wants. Only an explicit
  // opt-out turns it off, for a publisher that renders what it sent from the
  // event it sent and reconciles on the serial `send` returned.
  if (options.echoMessages === false) params.echo = 'false';
  const channelOptions: Ably.ChannelOptions = { params };
  const modes = resolveChannelModes(options.channelModes);
  if (modes) channelOptions.modes = modes;
  return channelOptions;
};
