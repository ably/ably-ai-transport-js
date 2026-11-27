import { EventType } from '@ag-ui/core';
import { describe, expect, it, type Mock, vi } from 'vitest';

import { agUiAdaptor } from '../../../src/ag-ui/index.js';
import { anthropicAdaptor } from '../../../src/anthropic/index.js';
import { type ChannelWriter, createAgentAdaptor } from '../../../src/core/adaptor/index.js';
import { withUsageReport } from '../../../src/core/adaptor/usage.js';
import { openaiAdaptor } from '../../../src/openai/index.js';
import { vercelAdaptor } from '../../../src/vercel/index.js';
import { VERSION } from '../../../src/version.js';
import { silentLogger } from '../../helper/logger.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { flushMicrotasks } from '../../helper/streams.js';
import { createTestCodec, streamOf, textEvents } from '../../helper/test-codec.js';

/** The part of an ably-js client the usage report reads, as a test double. */
interface FakeClient {
  options: { agents?: Record<string, string | boolean | undefined> };
  time: Mock<() => Promise<number>>;
}

/**
 * A mock channel with an ably-js-shaped `client`, as a `RealtimeChannel` has.
 * @param agents - The agents the client was created with.
 * @returns The channel and its client.
 */
const channelWithClient = (
  agents?: Record<string, string | boolean | undefined>,
): { channel: MockChannel; client: FakeClient } => {
  const client: FakeClient = { options: { agents }, time: vi.fn<() => Promise<number>>().mockResolvedValue(0) };
  const channel = Object.assign(createMockChannel(), { client });
  return { channel, client };
};

describe('usage report', () => {
  it('adds the agents to the client and sends one time request on the first write', async () => {
    const { channel, client } = channelWithClient();
    const adaptor = createAgentAdaptor(channel, createTestCodec());

    await adaptor.pipe(streamOf(...textEvents('a', 'x', 'y')));
    await adaptor.send({ type: 'note', text: 'n' });

    expect(client.options.agents).toEqual({ 'ai-transport-js': VERSION, 'ai-transport-custom': undefined });
    expect(client.time).toHaveBeenCalledTimes(1);
  });

  it('sends nothing before the first write', () => {
    const { channel, client } = channelWithClient();
    const adaptor = createAgentAdaptor(channel, createTestCodec());

    adaptor.newWriter();

    expect(client.time).not.toHaveBeenCalled();
    expect(client.options.agents).toBeUndefined();
  });

  it('keeps the agents the client already has', async () => {
    const { channel, client } = channelWithClient({ 'ably-pubsub-server': undefined, 'my-app': '2.0.0' });

    await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });

    expect(client.options.agents).toEqual({
      'ably-pubsub-server': undefined,
      'my-app': '2.0.0',
      'ai-transport-js': VERSION,
      'ai-transport-custom': undefined,
    });
  });

  it('sends no second time request for a client that already carries the agents', async () => {
    const { channel, client } = channelWithClient();

    await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });
    await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });

    expect(client.time).toHaveBeenCalledTimes(1);
  });

  it('reports again when another adaptor writes through the same client', async () => {
    const { channel, client } = channelWithClient();

    await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });
    await withUsageReport(channel, 'ai-transport-other', silentLogger).publish({ name: 'x' });

    expect(client.options.agents).toEqual({
      'ai-transport-js': VERSION,
      'ai-transport-custom': undefined,
      'ai-transport-other': undefined,
    });
    expect(client.time).toHaveBeenCalledTimes(2);
  });

  it('reports when the client carries an older release of the SDK', async () => {
    const { channel, client } = channelWithClient({ 'ai-transport-js': '0.0.1', 'ai-transport-custom': undefined });

    await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });

    expect(client.options.agents).toEqual({ 'ai-transport-js': VERSION, 'ai-transport-custom': undefined });
    expect(client.time).toHaveBeenCalledTimes(1);
  });

  it.each(['appendMessage', 'updateMessage'] as const)('reports when the first write is %s', async (method) => {
    const { channel, client } = channelWithClient();
    const wrapped = withUsageReport(channel, 'ai-transport-custom', silentLogger);

    await wrapped[method]({ serial: 'serial-1', data: 'x' });

    expect(channel[method]).toHaveBeenCalledWith({ serial: 'serial-1', data: 'x' });
    expect(client.time).toHaveBeenCalledTimes(1);
  });

  it('does not report on a read', async () => {
    const { channel, client } = channelWithClient();
    await channel.publish({ name: 'x', data: 'a' });
    const wrapped = withUsageReport(channel, 'ai-transport-custom', silentLogger);

    await wrapped.getMessage?.('serial-1');

    expect(channel.getMessage).toHaveBeenCalledWith('serial-1');
    expect(client.time).not.toHaveBeenCalled();
  });

  it('keeps a channel without getMessage without one', () => {
    const mock = createMockChannel();
    const channel: ChannelWriter = {
      publish: mock.publish,
      appendMessage: mock.appendMessage,
      updateMessage: mock.updateMessage,
    };

    expect('getMessage' in withUsageReport(channel, 'ai-transport-custom', silentLogger)).toBe(false);
  });

  it('does not let a failed time request touch the write', async () => {
    const { channel, client } = channelWithClient();
    client.time.mockRejectedValue(new Error('offline'));

    const result = await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });
    await flushMicrotasks();

    expect(result.serial).toBe('serial-1');
    expect(client.time).toHaveBeenCalledTimes(1);
  });

  it('writes as usual on a channel without a client', async () => {
    const channel = createMockChannel();

    const result = await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });

    expect(result.serial).toBe('serial-1');
  });

  it('writes as usual on a channel whose client is not shaped like ably-js', async () => {
    const client = { options: { agents: 'not-an-object' }, time: vi.fn() };
    const channel = Object.assign(createMockChannel(), { client });

    await createAgentAdaptor(channel, createTestCodec()).send({ type: 'note', text: 'n' });

    expect(client.time).not.toHaveBeenCalled();
    expect(client.options.agents).toBe('not-an-object');
  });

  it.each([
    ['vercelAdaptor', 'ai-transport-vercel', async (c: ChannelWriter) => vercelAdaptor(c).send({ type: 'start' })],
    [
      'openaiAdaptor',
      'ai-transport-openai',
      async (c: ChannelWriter) => openaiAdaptor(c).send({ type: 'input', items: [] }),
    ],
    [
      'anthropicAdaptor',
      'ai-transport-anthropic',
      async (c: ChannelWriter) => anthropicAdaptor(c).send({ type: 'input', messages: [] }),
    ],
    [
      'agUiAdaptor',
      'ai-transport-ag-ui',
      async (c: ChannelWriter) => agUiAdaptor(c).send({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' }),
    ],
  ])('%s reports its own adaptor agent', async (_, agent, write) => {
    const { channel, client } = channelWithClient();

    await write(channel);

    expect(client.options.agents).toEqual({ 'ai-transport-js': VERSION, [agent]: undefined });
    expect(client.time).toHaveBeenCalledTimes(1);
  });
});
