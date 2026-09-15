import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EncodedMessage } from '../../../src/core/codec/index.js';
import type { PipeWriter } from '../../../src/core/transport/pipe-writer.js';
import { createPipeWriter } from '../../../src/core/transport/pipe-writer.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';

const publish = (key?: string, data: unknown = '', extras: unknown = {}): EncodedMessage =>
  key === undefined
    ? { message: { name: 'ai', data, extras } }
    : { message: { name: 'ai', data, extras }, publish: key };
const append = (key: string, data: string, extras: unknown = {}): EncodedMessage => ({
  message: { data, extras },
  append: key,
});
const end = (key: string, extras: unknown = {}): EncodedMessage => ({
  message: { data: '', extras },
  append: key,
  ends: key,
});
const update = (key: string, data: string, extras: unknown = {}): EncodedMessage => ({
  message: { data, extras },
  update: key,
});

/** Run the pending microtasks to completion so unawaited appends have reached the channel. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

/**
 * Make the channel hold every append open until the test releases it, so the
 * order the writer sends them in can be observed.
 * @param channel - The mock channel.
 * @returns The release functions, one per append sent, in send order.
 */
const holdAppends = (channel: MockChannel): (() => void)[] => {
  const releases: (() => void)[] = [];
  channel.appendMessage.mockImplementation(
    async (msg) =>
      new Promise((resolve) => {
        channel.appendCalls.push(msg);
        releases.push(() => {
          // CAST: the writer reads nothing off the result.
          resolve({} as Ably.UpdateDeleteResult);
        });
      }),
  );
  return releases;
};

// CAST: `Ably.Message.data` is typed `any`; the tests compare it as a value.
const dataOf = (calls: Ably.Message[]): unknown[] => calls.map((m) => m.data as unknown);

describe('createPipeWriter', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let writer: PipeWriter;

  beforeEach(() => {
    channel = createMockChannel();
    writer = createPipeWriter(channel);
  });

  describe('publish', () => {
    it('publishes and returns the ack serial', async () => {
      await expect(writer.write(publish(undefined, 'hello'))).resolves.toBe('serial-1');
      expect(channel.publishCalls).toEqual([{ name: 'ai', data: 'hello', extras: {} }]);
    });

    it('remembers the serial under the key', async () => {
      await writer.write(publish('k1', ''));
      await writer.write(append('k1', 'Hello'));
      expect(channel.appendCalls).toEqual([{ serial: 'serial-1', data: 'Hello', extras: { ai: { stream: true } } }]);
    });

    it('does not wait for pending appends before a publish', async () => {
      await writer.write(publish('k1'));
      const releases = holdAppends(channel);
      await writer.write(append('k1', 'a'));
      await expect(writer.write(publish(undefined, 'after'))).resolves.toBe('serial-2');
      expect(dataOf(channel.publishCalls)).toEqual(['', 'after']);
      for (const release of releases) release();
    });

    it('throws for a publish under a live key', async () => {
      await writer.write(publish('k1'));
      await expect(writer.write(publish('k1'))).rejects.toBeErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to publish; key 'k1' is still live, use update to replace its content or end it first",
      });
      expect(channel.publishCalls).toHaveLength(1);
    });

    it('allows a key to be reused once ended', async () => {
      await writer.write(publish('k1'));
      await writer.write(end('k1'));
      await expect(writer.write(publish('k1'))).resolves.toBe('serial-2');
    });

    it('throws InternalError when the ack carries no serial', async () => {
      channel.publish.mockResolvedValueOnce({ serials: [] });
      await expect(writer.write(publish())).rejects.toBeErrorInfoWithCode(ErrorCode.InternalError);
    });
  });

  describe('append', () => {
    it('does not await the append', async () => {
      await writer.write(publish('k1'));
      let release: (() => void) | undefined;
      channel.appendMessage.mockReturnValueOnce(
        new Promise<Ably.UpdateDeleteResult>((resolve) => {
          release = () => {
            // CAST: the writer reads nothing off the result.
            resolve({} as Ably.UpdateDeleteResult);
          };
        }),
      );
      await expect(writer.write(append('k1', 'Hello'))).resolves.toBeUndefined();
      expect(release).toBeDefined();
      release?.();
    });

    it('sends the appends of one stream as they arrive, without waiting for an ack', async () => {
      await writer.write(publish('k1'));
      const releases = holdAppends(channel);
      await writer.write(append('k1', 'a'));
      await writer.write(append('k1', 'b'));
      expect(dataOf(channel.appendCalls)).toEqual(['a', 'b']);
      for (const release of releases) release();
    });

    it('sends appends to different streams without waiting on each other', async () => {
      await writer.write(publish('k1'));
      await writer.write(publish('k2'));
      const releases = holdAppends(channel);
      await writer.write(append('k1', 'a'));
      await writer.write(append('k2', 'b'));
      await settle();
      expect(dataOf(channel.appendCalls)).toEqual(['a', 'b']);
      for (const release of releases) release();
    });

    it('publishes an append to a key that is not live, opening the key under the ack serial', async () => {
      const opener: EncodedMessage = { message: { name: 'ai', data: 'Hello', extras: { type: 'd' } }, append: 'k9' };
      await expect(writer.write(opener)).resolves.toBe('serial-1');
      expect(channel.publishCalls).toEqual([
        { name: 'ai', data: 'Hello', extras: { type: 'd', ai: { stream: true } } },
      ]);
      expect(channel.appendCalls).toHaveLength(0);

      await writer.write(append('k9', ' world'));
      expect(channel.appendCalls).toEqual([{ serial: 'serial-1', data: ' world', extras: { ai: { stream: true } } }]);
    });

    it('awaits the publish that opens a key before returning', async () => {
      let release: ((result: Ably.PublishResult) => void) | undefined;
      channel.publish.mockReturnValueOnce(
        new Promise<Ably.PublishResult>((resolve) => {
          release = resolve;
        }),
      );
      let settled = false;
      const opening = writer.write(append('k1', 'first')).then(() => {
        settled = true;
      });
      await settle();
      expect(settled).toBe(false);
      release?.({ serials: ['serial-9'] });
      await opening;
      await writer.write(append('k1', 'second'));
      expect(channel.appendCalls).toEqual([{ serial: 'serial-9', data: 'second', extras: { ai: { stream: true } } }]);
    });

    it('opens a key again with a publish once it has ended', async () => {
      await writer.write(publish('k1'));
      await writer.write(end('k1'));
      await expect(writer.write(append('k1', 'late'))).resolves.toBe('serial-2');
      expect(dataOf(channel.publishCalls)).toEqual(['', 'late']);
    });

    it('repairs a stream the first append opened with the text it accumulated', async () => {
      await writer.write(append('k1', 'The', { type: 'text-delta', id: 'k1' }));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', ' weather', { type: 'text-delta', id: 'k1' }));
      await writer.write({ message: { name: 'ai', data: '', extras: { type: 'text-end' } }, ends: 'k1' });
      expect(channel.updateCalls).toEqual([
        { serial: 'serial-1', data: 'The weather', extras: { type: 'text-delta', id: 'k1', ai: { stream: true } } },
      ]);
    });
  });

  describe('stream markers', () => {
    it('marks every write under a key as a stream, and a plain publish as nothing', async () => {
      await writer.write(publish('k1', 'open', { type: 'a' }));
      await writer.write(append('k1', ' more', { type: 'd' }));
      await writer.write(update('k1', 'final', { type: 'u' }));
      await writer.write(publish(undefined, 'aside', { type: 'p' }));
      expect(channel.publishCalls.map((m) => m.extras as unknown)).toEqual([
        { type: 'a', ai: { stream: true } },
        { type: 'p' },
      ]);
      expect(channel.appendCalls.map((m) => m.extras as unknown)).toEqual([{ type: 'd', ai: { stream: true } }]);
      expect(channel.updateCalls.map((m) => m.extras as unknown)).toEqual([{ type: 'u', ai: { stream: true } }]);
    });

    it('adds extras.ai to a message that carries none, without mutating the encoded message', async () => {
      const encoded: EncodedMessage = { message: { name: 'ai', data: 'x' }, append: 'k1' };
      await writer.write(encoded);
      expect(channel.publishCalls).toEqual([{ name: 'ai', data: 'x', extras: { ai: { stream: true } } }]);
      expect(encoded.message.extras).toBeUndefined();
    });

    it('names the serial of the message a closer ends, and nothing for a key that is not live', async () => {
      await writer.write(append('k1', 'text'));
      await writer.write({ message: { name: 'ai', data: '', extras: { type: 'end' } }, ends: 'k1' });
      await writer.write({ message: { name: 'ai', data: '', extras: { type: 'end' } }, ends: 'k9' });
      expect(channel.publishCalls.map((m) => m.extras as unknown)).toEqual([
        { ai: { stream: true } },
        { type: 'end', ai: { ends: 'serial-1' } },
        { type: 'end' },
      ]);
    });

    it('repairs a failed append before publishing the closer, keeping the marker on the repaired message', async () => {
      await writer.write(append('k1', 'The'));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', ' weather'));
      await writer.write({ message: { name: 'ai', data: '', extras: { type: 'end' } }, ends: 'k1' });
      const [repairOrder = 0] = channel.updateMessage.mock.invocationCallOrder;
      const [, closerOrder = 0] = channel.publish.mock.invocationCallOrder;
      expect(repairOrder).toBeLessThan(closerOrder);
      expect(channel.updateCalls).toEqual([
        { serial: 'serial-1', data: 'The weather', extras: { ai: { stream: true } } },
      ]);
    });
  });

  describe('update', () => {
    it('awaits the update and routes it to the key', async () => {
      await writer.write(publish('k1', 'draft'));
      await expect(writer.write(update('k1', 'final', { type: 'r' }))).resolves.toBeUndefined();
      expect(channel.updateCalls).toEqual([
        { serial: 'serial-1', data: 'final', extras: { type: 'r', ai: { stream: true } } },
      ]);
    });

    it('throws for an update to a key that is not live', async () => {
      await expect(writer.write(update('k9', 'x'))).rejects.toBeErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to update; no live stream for key 'k9'",
      });
    });

    it('propagates the update failure', async () => {
      await writer.write(publish('k1'));
      channel.updateMessage.mockRejectedValueOnce(new Ably.ErrorInfo('boom', 50000, 500));
      await expect(writer.write(update('k1', 'x'))).rejects.toBeErrorInfoWithCode(50000);
    });
  });

  describe('ends', () => {
    it('awaits pending appends before forgetting the key', async () => {
      await writer.write(publish('k1'));
      await writer.write(append('k1', 'a'));
      await writer.write(end('k1'));
      expect(channel.appendCalls).toHaveLength(2);
      expect(channel.updateCalls).toHaveLength(0);
    });

    it('waits for the stream’s pending appends before sending the append that ends it', async () => {
      // The platform merges appends that arrive close together into one
      // delivery under the last one's extras, so a closer sent behind an
      // unacked delta could swallow the delta's text.
      await writer.write(publish('k1'));
      const releases = holdAppends(channel);
      await writer.write(append('k1', 'a'));
      const ending = writer.write(end('k1'));
      await settle();
      expect(dataOf(channel.appendCalls)).toEqual(['a']);
      releases[0]?.();
      await settle();
      expect(dataOf(channel.appendCalls)).toEqual(['a', '']);
      releases[1]?.();
      await ending;
    });

    it('waits for the stream’s pending appends before a publish that ends it', async () => {
      await writer.write(publish('k1'));
      const releases = holdAppends(channel);
      await writer.write(append('k1', 'a'));
      const ending = writer.write({ message: { name: 'ai', data: 'done', extras: {} }, ends: 'k1' });
      await settle();
      expect(channel.publishCalls).toHaveLength(1);
      releases[0]?.();
      await ending;
      expect(dataOf(channel.publishCalls)).toEqual(['', 'done']);
    });

    it('does not wait for another stream’s appends before a closer', async () => {
      await writer.write(publish('k1'));
      await writer.write(publish('k2'));
      const releases = holdAppends(channel);
      await writer.write(append('k2', 'other'));
      const ending = writer.write(end('k1'));
      await settle();
      expect(dataOf(channel.appendCalls)).toEqual(['other', '']);
      for (const release of releases) release();
      await ending;
    });

    it('forgets a key named by a message outside its stream', async () => {
      await writer.write(publish('k1'));
      await writer.write({ message: { name: 'ai', data: 'result', extras: {} }, ends: 'k1' });
      // The key is no longer live, so an update to it has nothing to target.
      await expect(writer.write(update('k1', 'late'))).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('repair', () => {
    it('replaces the content of a stream whose append failed, with the last delta’s extras, before the closer', async () => {
      await writer.write(publish('k1', 'The', { type: 'text-start', id: 'k1' }));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', ' weather', { type: 'text-delta', id: 'k1' }));
      await writer.write(append('k1', ' in London', { type: 'text-delta', id: 'k1' }));
      await writer.write({ message: { name: 'ai', data: '', extras: { type: 'text-end', id: 'k1' } }, ends: 'k1' });
      expect(channel.updateCalls).toEqual([
        {
          serial: 'serial-1',
          data: 'The weather in London',
          extras: { type: 'text-delta', id: 'k1', ai: { stream: true } },
        },
      ]);
    });

    it('repairs at flush a stream the source never ended', async () => {
      await writer.write(publish('k1', ''));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', 'partial'));
      await writer.flush();
      expect(channel.updateCalls).toEqual([{ serial: 'serial-1', data: 'partial', extras: { ai: { stream: true } } }]);
    });

    it('repairs only the streams whose appends failed', async () => {
      await writer.write(publish('k1'));
      await writer.write(publish('k2'));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', 'lost'));
      await writer.write(append('k2', 'fine'));
      await writer.flush();
      expect(channel.updateCalls.map((m) => m.serial)).toEqual(['serial-1']);
    });

    it('throws StreamedMessageFinalizeFailed when a repair fails, with the first failure as cause', async () => {
      await writer.write(publish('k1'));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', 'lost'));
      channel.updateMessage.mockRejectedValueOnce(new Ably.ErrorInfo('still down', 50000, 500));
      await expect(writer.write(end('k1'))).rejects.toBeErrorInfo({
        code: ErrorCode.StreamedMessageFinalizeFailed,
        cause: { code: 50000 },
      });
    });

    it('is idempotent once pending appends are drained', async () => {
      await writer.write(publish('k1'));
      await writer.write(append('k1', 'a'));
      await writer.flush();
      await writer.flush();
      expect(channel.updateCalls).toHaveLength(0);
    });

    it('shares one flush between concurrent callers', async () => {
      await writer.write(publish('k1'));
      await writer.write(append('k1', 'a'));
      const spy = vi.spyOn(channel, 'updateMessage');
      await Promise.all([writer.flush(), writer.flush()]);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not surface an append rejection before flush', async () => {
      await writer.write(publish('k1'));
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      await writer.write(append('k1', 'lost'));
      await settle();
      // Reaching here without an unhandled rejection is the assertion; the
      // failure is then collected by flush.
      await writer.flush();
      expect(channel.updateCalls).toHaveLength(1);
    });
  });
});
