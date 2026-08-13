/**
 * Linear conversation primitives. No parent / fork-of / msg-regenerate / supersedes.
 *
 * Platform: clone, truncate, publish, delete.
 * App: turn-id groups alternatives; UI picks last-write, show both, or 1/N.
 */
import type * as Ably from 'ably';

export const HEADER_TURN_ID = 'turn-id';

export type LinearMessage = {
	serial?: string | null;
	data?: unknown;
	action?: string;
	extras?: { headers?: Record<string, string> };
};

export async function cloneChannel(
	rest: Ably.Rest,
	src: string,
	dest: string,
	untilSerial?: string,
): Promise<Ably.HttpPaginatedResponse> {
	const body: { destChannel: string; untilSerial?: string } = { destChannel: dest };
	if (untilSerial) {
		body.untilSerial = untilSerial;
	}
	return rest.request('POST', `/channels/${src}/clone`, 3, {}, body);
}

export async function truncateAfter(rest: Ably.Rest, channel: string, afterSerial: string): Promise<Ably.HttpPaginatedResponse> {
	return rest.request('POST', `/channels/${channel}/truncate`, 3, {}, { afterSerial });
}

export function turnIdOf(msg: LinearMessage): string | undefined {
	return msg.extras?.headers?.[HEADER_TURN_ID];
}

/** History rows the user should see. Deletes stay in the log; the UI drops them. */
export function visible(items: LinearMessage[]): LinearMessage[] {
	return items.filter((m) => m.action !== 'message.delete');
}

/** Distinct bodies that share a turn-id. The pager is UI over this list. */
export function alternatives(items: LinearMessage[], turnId: string): LinearMessage[] {
	return visible(items).filter((m) => turnIdOf(m) === turnId);
}

export function lastWrite(items: LinearMessage[], turnId: string): LinearMessage | undefined {
	const alts = alternatives(items, turnId);
	return alts[alts.length - 1];
}
