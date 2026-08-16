/**
 * Linear conversation primitives. No parent / fork-of / msg-regenerate / supersedes.
 *
 * Platform: clone, truncate, publish, delete.
 * App: turn-id groups alternatives; UI picks last-write, show both, or 1/N.
 */
import type * as Ably from 'ably';

export const HEADER_TURN_ID = 'turn-id';
/** Streaming status. POC shim on extras.headers. Not extras.ai. */
export const HEADER_STREAM_STATUS = 'stream-status';
/** Retry identity. Not REST message id (that stays idempotent). Store isolation is POC D. */
export const HEADER_RETRY_IDENTITY = 'retry-identity';
/** If this work id exists, create a new version. Same extras on every attempt. */
export const HEADER_IF_EXISTS = 'if-exists';
export const IF_EXISTS_NEW_VERSION = 'newVersion';
/** Overlapping group ids, comma-separated. No parent. */
export const HEADER_SPANS = 'spans';

export type LinearMessage = {
	id?: string;
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

export function streamStatusOf(msg: LinearMessage): string | undefined {
	return msg.extras?.headers?.[HEADER_STREAM_STATUS];
}

export function retryIdentityOf(msg: LinearMessage): string | undefined {
	return msg.extras?.headers?.[HEADER_RETRY_IDENTITY];
}

export function spansOf(msg: LinearMessage): string[] {
	const raw = msg.extras?.headers?.[HEADER_SPANS];
	if (!raw) {
		return [];
	}
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Latest body per retry-identity. Older attempts stay in the log. */
export function latestByIdentity(items: LinearMessage[]): LinearMessage[] {
	const last = new Map<string, number>();
	visible(items).forEach((m, i) => {
		const id = retryIdentityOf(m);
		if (id) {
			last.set(id, i);
		}
	});
	return visible(items).filter((m, i) => {
		const id = retryIdentityOf(m);
		return !id || last.get(id) === i;
	});
}

/** Apply an append. After complete/stopped, the default body does not grow. */
export function applyAppend(base: LinearMessage, delta: string): LinearMessage {
	const status = streamStatusOf(base);
	if (status === 'complete' || status === 'stopped') {
		return base;
	}
	return { ...base, data: String(base.data ?? '') + delta };
}

/** Drop messages in a span after `fromSerial` (inclusive cut keeps fromSerial). */
export function cutSpan(items: LinearMessage[], spanId: string, fromSerial: string): LinearMessage[] {
	let past = false;
	return items.map((m) => {
		if (m.serial === fromSerial) {
			past = true;
			const headers = { ...m.extras?.headers, [HEADER_STREAM_STATUS]: 'stopped' };
			return { ...m, extras: { ...m.extras, headers } };
		}
		if (past && spansOf(m).includes(spanId)) {
			return { ...m, action: 'message.delete' };
		}
		return m;
	});
}

/**
 * Drop-in request path: their POST. Only after accept do we publish.
 * Unaccepted text never lands on the channel.
 */
export function acceptAndPublish(
	accepted: boolean,
	draft: { data: string; turnId: string },
): LinearMessage | null {
	if (!accepted) {
		return null;
	}
	return {
		data: draft.data,
		action: 'message.create',
		extras: { headers: { [HEADER_TURN_ID]: draft.turnId } },
	};
}

/**
 * Blind attempt. Same extras every time. Do not ask if a previous attempt worked.
 * Missing work id → create. Exists → new version.
 */
export function ifExistsNewVersion(workId: string): { extras: { ifExists: string; identity: string; headers: Record<string, string> } } {
	return {
		extras: {
			ifExists: IF_EXISTS_NEW_VERSION,
			identity: workId,
			headers: { [HEADER_IF_EXISTS]: IF_EXISTS_NEW_VERSION, [HEADER_RETRY_IDENTITY]: workId },
		},
	};
}
