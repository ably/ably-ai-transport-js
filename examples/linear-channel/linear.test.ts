import { describe, expect, it } from 'vitest';
import {
	acceptAndPublish,
	alternatives,
	applyAppend,
	cutSpan,
	HEADER_RETRY_IDENTITY,
	HEADER_SPANS,
	HEADER_STREAM_STATUS,
	HEADER_TURN_ID,
	lastWrite,
	latestByIdentity,
	visible,
	type LinearMessage,
} from './linear.ts';

function msg(data: string, turnId: string, action = 'message.create'): LinearMessage {
	return { data, action, extras: { headers: { [HEADER_TURN_ID]: turnId } } };
}

describe('linear conversation helpers', () => {
	it('hides deletes from the visible list', () => {
		const items = [msg('keep', 't1'), { ...msg('gone', 't2'), action: 'message.delete' }, msg('later', 't3')];
		expect(visible(items).map((m) => m.data)).toEqual(['keep', 'later']);
	});

	it('groups regenerate bodies by turn-id', () => {
		const items = [msg('v1', 't4'), msg('v2', 't4'), msg('other', 't5')];
		expect(alternatives(items, 't4').map((m) => m.data)).toEqual(['v1', 'v2']);
		expect(lastWrite(items, 't4')?.data).toBe('v2');
	});

	it('does not publish when the POST is rejected', () => {
		expect(acceptAndPublish(false, { data: 'nope', turnId: 't' })).toBeNull();
		expect(acceptAndPublish(true, { data: 'hello', turnId: 't' })?.data).toBe('hello');
	});

	it('freezes the default body after stopped', () => {
		const open: LinearMessage = { data: 'Hel', extras: { headers: { [HEADER_STREAM_STATUS]: 'open' } } };
		const stopped: LinearMessage = { data: 'Hel', extras: { headers: { [HEADER_STREAM_STATUS]: 'stopped' } } };
		expect(applyAppend(open, 'lo').data).toBe('Hello');
		expect(applyAppend(stopped, 'lo').data).toBe('Hel');
	});

	it('keeps the latest retry identity only', () => {
		const items: LinearMessage[] = [
			{ data: 'old', extras: { headers: { [HEADER_RETRY_IDENTITY]: 'asst-1' } } },
			{ data: 'new', extras: { headers: { [HEADER_RETRY_IDENTITY]: 'asst-1' } } },
			{ data: 'other', extras: { headers: { [HEADER_TURN_ID]: 'x' } } },
		];
		expect(latestByIdentity(items).map((m) => m.data)).toEqual(['new', 'other']);
	});

	it('lets a second writer append while the stream is still open', () => {
		const open: LinearMessage = { data: 'Hel', extras: { headers: { [HEADER_STREAM_STATUS]: 'open' } } };
		expect(applyAppend(open, 'lo').data).toBe('Hello');
	});

	it('cuts a span from a serial and keeps the stopped bubble', () => {
		const items: LinearMessage[] = [
			{ serial: '1', data: 'user', extras: { headers: { [HEADER_SPANS]: 'turn-1' } } },
			{ serial: '2', data: 'partial', extras: { headers: { [HEADER_SPANS]: 'turn-1,step-9' } } },
			{ serial: '3', data: 'late-tool', extras: { headers: { [HEADER_SPANS]: 'turn-1,step-9' } } },
		];
		const cut = cutSpan(items, 'turn-1', '2');
		expect(visible(cut).map((m) => m.data)).toEqual(['user', 'partial']);
		expect(cut[1].extras?.headers?.[HEADER_STREAM_STATUS]).toBe('stopped');
	});
});
