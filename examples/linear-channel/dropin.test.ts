import { describe, expect, it } from 'vitest';

import { handleChatPost, resetDropin } from './dropin.ts';
import { HEADER_STREAM_STATUS } from './linear.ts';

describe('drop-in POST /chat', () => {
  it('does not publish when the POST is rejected', () => {
    resetDropin();
    expect(handleChatPost({ text: 'hi', accepted: false }).publish).toBeUndefined();
    expect(handleChatPost({ text: '' }).status).toBe(400);
  });

  it('publishes user then open assistant only after accept', () => {
    resetDropin();
    const res = handleChatPost({ text: 'What is Rust?' });
    expect(res.status).toBe(200);
    expect(res.publish?.map((m) => m.data)).toEqual(['What is Rust?', '']);
    expect(res.publish?.[1].extras?.headers?.[HEADER_STREAM_STATUS]).toBe('open');
    expect(JSON.stringify(res.publish)).not.toMatch(/extras\.ai|parent|ai-input/);
  });

  it('dedups a retried POST with the same REST id', () => {
    resetDropin();
    const first = handleChatPost({ text: 'hello', id: 'user-1' });
    const again = handleChatPost({ text: 'hello', id: 'user-1' });
    expect(first.publish).toHaveLength(2);
    expect(again.publish).toEqual([]);
  });
});
