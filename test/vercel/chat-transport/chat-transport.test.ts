import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { createChatTransport } from '../../../src/vercel/index.js';
import { createMockChannel } from '../../helper/mock-channel.js';
import { createMockClient } from '../../helper/mock-client.js';

describe('createChatTransport', () => {
  it('rejects an empty channel name', () => {
    const client = createMockClient(createMockChannel());
    expect(() => createChatTransport({ client, channelName: '' })).toThrowErrorInfo({
      code: ErrorCode.InvalidArgument,
      message: 'unable to create chat transport; channelName must be a non-empty string',
    });
  });

  it('declares that a resumed stream replays its turn from the start', () => {
    const client = createMockClient(createMockChannel());
    expect(createChatTransport({ client, channelName: 'chat' }).resumeStreamIsReplay).toBe(true);
  });

  it('resolves the channel with its options when created, without attaching it', () => {
    const channel = createMockChannel();
    const client = createMockClient(channel);

    createChatTransport({ client, channelName: 'chat' });

    const [name, options] = client.channels.get.mock.calls[0] ?? [];
    expect(name).toBe('chat');
    expect(typeof options?.params?.agent).toBe('string');
    expect(channel.subscribe).not.toHaveBeenCalled();
    expect(channel.attach).not.toHaveBeenCalled();
  });
});
