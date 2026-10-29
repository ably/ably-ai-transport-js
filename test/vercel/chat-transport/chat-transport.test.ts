import type * as Ably from '@ably/pubsub-core';
import { describe, expect, it } from 'vitest';

import { createChatTransport } from '../../../src/vercel/index.js';

describe('createChatTransport', () => {
  it('declares that a resumed stream replays its turn from the start', () => {
    // CAST: the transport reads nothing off its channel but the name until its first call.
    const channel = { name: 'chat' } as Ably.RealtimeChannel;
    expect(createChatTransport({ channel }).resumeStreamIsReplay).toBe(true);
  });
});
