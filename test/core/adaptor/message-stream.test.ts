import * as Ably from '@ably/pubsub-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openMessageStream, publishMessage } from '../../../src/core/adaptor/message-stream.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { flushMicrotasks } from '../../helper/streams.js';

// CAST: the message stream reads nothing off an append's or an update's ack.
const ack = {} as Ably.UpdateDeleteResult;

describe('publishMessage', () => {
  it('publishes the message and returns the serial its ack names', async () => {
    const channel = createMockChannel();
    await expect(publishMessage(channel, { name: 'ai', data: 'x' })).resolves.toBe('serial-1');
    expect(channel.publishCalls).toEqual([{ name: 'ai', data: 'x' }]);
  });

  it('throws InternalError when the ack carries no serial', async () => {
    const channel = createMockChannel();
    channel.publish.mockResolvedValueOnce({ serials: [] });
    await expect(publishMessage(channel, { data: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.InternalError);
  });
});

describe('a message stream', () => {
  let channel: MockChannel;

  beforeEach(() => {
    channel = createMockChannel();
  });

  it('opens with a publish and names the message it writes to', async () => {
    const stream = await openMessageStream(channel, { name: 'ai', data: 'The' });
    expect(stream.serial).toBe('serial-1');
    expect(channel.publishCalls).toEqual([{ name: 'ai', data: 'The' }]);
  });

  it('appends to its message without waiting for the ack', async () => {
    const stream = await openMessageStream(channel, { data: 'The' });
    const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
    channel.appendMessage.mockReturnValueOnce(pending.promise);
    stream.append({ data: ' weather' });
    stream.append({ data: ' today' });
    expect(channel.appendMessage.mock.calls.map(([m]) => [m.serial, m.data as unknown])).toEqual([
      ['serial-1', ' weather'],
      ['serial-1', ' today'],
    ]);
    pending.resolve(ack);
    await expect(stream.flush()).resolves.toBe(false);
  });

  it('waits at flush for the appends sent before it', async () => {
    const stream = await openMessageStream(channel, { data: 'The' });
    const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
    channel.appendMessage.mockReturnValueOnce(pending.promise);
    stream.append({ data: ' weather' });
    let flushed = false;
    const flushing = stream.flush().then(() => {
      flushed = true;
    });
    await flushMicrotasks();
    expect(flushed).toBe(false);
    pending.resolve(ack);
    await flushing;
    expect(flushed).toBe(true);
  });

  it("repairs the message at flush with its whole content and the last write's name and extras, when an append failed", async () => {
    const stream = await openMessageStream(channel, { name: 'start', data: 'The', extras: { a: 1 } });
    channel.appendMessage.mockRejectedValueOnce(new Error('network'));
    stream.append({ name: 'delta', data: ' weather', extras: { b: 2 } });
    stream.append({ name: 'delta', data: ' today', extras: { c: 3 } });
    await expect(stream.flush()).resolves.toBe(true);
    expect(channel.updateCalls).toEqual([
      { serial: 'serial-1', name: 'delta', data: 'The weather today', extras: { c: 3 } },
    ]);
    await expect(stream.flush()).resolves.toBe(false);
  });

  it('repairs from the content an update replaced', async () => {
    const stream = await openMessageStream(channel, { data: 'The' });
    await stream.update({ data: 'A' });
    channel.appendMessage.mockRejectedValueOnce(new Error('network'));
    stream.append({ data: 'B' });
    await stream.flush();
    expect(channel.updateCalls.map((m) => m.data as unknown)).toEqual(['A', 'AB']);
  });

  it('throws what the channel threw when the repair fails', async () => {
    const stream = await openMessageStream(channel, { data: 'The' });
    channel.appendMessage.mockRejectedValueOnce(new Error('network'));
    stream.append({ data: ' weather' });
    const refusal = new Ably.ErrorInfo('still down', 50000, 500);
    channel.updateMessage.mockRejectedValueOnce(refusal);
    await expect(stream.flush()).rejects.toBe(refusal);
  });

  it('throws what the channel threw for an update', async () => {
    const stream = await openMessageStream(channel, { data: 'The' });
    const refusal = new Ably.ErrorInfo('down', 50000, 500);
    channel.updateMessage.mockRejectedValueOnce(refusal);
    await expect(stream.update({ data: 'A' })).rejects.toBe(refusal);
  });

  it('warns when an append fails', async () => {
    const logHandler = vi.fn();
    const stream = await openMessageStream(
      channel,
      { data: 'The' },
      makeLogger({ logLevel: LogLevel.Warn, logHandler }),
    );
    channel.appendMessage.mockRejectedValueOnce(new Error('network'));
    stream.append({ data: ' weather' });
    await flushMicrotasks();
    expect(logHandler).toHaveBeenCalledWith(
      expect.stringContaining('append failed, the next flush repairs the stream'),
      LogLevel.Warn,
      expect.objectContaining({ serial: 'serial-1', error: 'network' }),
    );
  });
});
