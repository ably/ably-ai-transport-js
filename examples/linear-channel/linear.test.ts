import { describe, expect, it } from 'vitest';
import { alternatives, HEADER_TURN_ID, lastWrite, visible, type LinearMessage } from './linear.ts';

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
});
