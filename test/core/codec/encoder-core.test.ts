import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { createEncoderCore } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel } from '../../helper/mock-realtime.js';

const makeCore = () => {
  const channel = createMockChannel();
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const core = createEncoderCore(channel, { logger });
  return { core, channel };
};

const headersOf = (message: Ably.Message): Record<string, string> => {
  // CAST: tests own the structure of `extras` they passed in.
  const extras = message.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
};

describe('EncoderCore', () => {
  describe('publish', () => {
    it('publishes one wire with x-ably-stream:false and the supplied headers', async () => {
      const { core, channel } = makeCore();

      await core.publish({ name: 'text', data: 'hi' }, { headers: { 'x-codec-flag': 'on' } });

      expect(channel.publish).toHaveBeenCalledTimes(1);
      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('text');
      expect(wire.data).toBe('hi');
      expect(headersOf(wire)[Headers.Stream]).toBe('false');
      expect(headersOf(wire)['x-codec-flag']).toBe('on');
    });

    it('attaches extras.ephemeral when requested', async () => {
      const { core, channel } = makeCore();

      await core.publish({ name: 'text', data: 'hi' }, { ephemeral: true });

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      // CAST: tests own the structure of `extras` they passed in.
      const extras = wire.extras as { ephemeral?: boolean } | undefined;
      expect(extras?.ephemeral).toBe(true);
    });
  });

  describe('publishBatch', () => {
    it('publishes every payload atomically and stamps x-ably-discrete on each wire', async () => {
      const { core, channel } = makeCore();

      await core.publishBatch(
        [
          { name: 'text', data: 'one' },
          { name: 'text', data: 'two' },
        ],
        { headers: { 'x-codec-flag': 'on' } },
      );

      expect(channel.publish).toHaveBeenCalledTimes(1);
      const batch = channel.publishedBatches[0] ?? [];
      expect(batch).toHaveLength(2);
      for (const wire of batch) {
        expect(headersOf(wire)[Headers.Discrete]).toBe('true');
        expect(headersOf(wire)[Headers.Stream]).toBe('false');
        expect(headersOf(wire)['x-codec-flag']).toBe('on');
      }
    });
  });

  describe('startStream', () => {
    it('publishes a streamed create with stream/status/streamId headers and captures the serial', async () => {
      const { core, channel } = makeCore();

      await core.startStream('s-1', { name: 'text', data: '' }, { headers: { 'x-codec-flag': 'on' } });

      const [wire] = channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected one wire');
      expect(wire.name).toBe('text');
      const headers = headersOf(wire);
      expect(headers[Headers.Stream]).toBe('true');
      expect(headers[Headers.Status]).toBe('streaming');
      expect(headers[Headers.StreamId]).toBe('s-1');
      expect(headers['x-codec-flag']).toBe('on');
    });

    it('rejects when the publish does not return a serial', async () => {
      const { core, channel } = makeCore();
      channel.publish.mockResolvedValueOnce({ serials: [] });

      await expect(core.startStream('s-1', { name: 'text', data: '' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.BadRequest,
      );
    });
  });

  describe('appendStream', () => {
    it('appends data against the captured serial with persistent headers from start', async () => {
      const { core, channel } = makeCore();
      await core.startStream('s-1', { name: 'text', data: '' }, { headers: { 'x-codec-flag': 'on' } });

      core.appendStream('s-1', 'hello');

      // appendMessage is fire-and-forget — let microtasks settle.
      await Promise.resolve();
      expect(channel.appendedMessages).toHaveLength(1);
      const append = channel.appendedMessages[0];
      if (!append) throw new Error('expected an append');
      expect(append.data).toBe('hello');
      expect(append.serial).toBe('mock-serial-0');
      const headers = headersOf(append);
      expect(headers['x-codec-flag']).toBe('on');
      expect(headers[Headers.StreamId]).toBe('s-1');
    });

    it('throws InvalidArgument when the streamId is unknown', () => {
      const { core } = makeCore();
      expect(() => {
        core.appendStream('s-bogus', 'hello');
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('closeStream', () => {
    it('publishes a finished append carrying the closing payload and stream headers', async () => {
      const { core, channel } = makeCore();
      await core.startStream('s-1', { name: 'text', data: '' });
      core.appendStream('s-1', 'hi');

      await core.closeStream('s-1', { name: 'text', data: '' });

      // The closing append is the last one recorded.
      expect(channel.appendedMessages.length).toBeGreaterThanOrEqual(2);
      const closing = channel.appendedMessages.at(-1);
      if (!closing) throw new Error('expected a closing append');
      expect(headersOf(closing)[Headers.Status]).toBe('finished');
      expect(headersOf(closing)[Headers.StreamId]).toBe('s-1');
    });

    it('recovers via updateMessage when an append rejected, carrying the accumulated buffer', async () => {
      const { core, channel } = makeCore();
      await core.startStream('s-1', { name: 'text', data: '' });
      // First append rejects; the subsequent close-time flush should
      // recover by calling channel.updateMessage with the full buffer.
      channel.appendMessage.mockRejectedValueOnce(new Error('append failed'));
      core.appendStream('s-1', 'hello');
      core.appendStream('s-1', ' world');

      await core.closeStream('s-1', { name: 'text', data: '' });

      expect(channel.updateMessage).toHaveBeenCalledTimes(1);
      const recovery = channel.updatedMessages[0];
      if (!recovery) throw new Error('expected a recovery wire');
      expect(recovery.data).toBe('hello world');
      expect(headersOf(recovery)[Headers.Status]).toBe('finished');
    });

    it('throws EncoderRecoveryFailed when the recovery itself rejects', async () => {
      const { core, channel } = makeCore();
      await core.startStream('s-1', { name: 'text', data: '' });
      channel.appendMessage.mockRejectedValueOnce(new Error('append failed'));
      channel.updateMessage.mockRejectedValueOnce(new Error('update failed'));
      core.appendStream('s-1', 'hello');

      await expect(core.closeStream('s-1', { name: 'text', data: '' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.EncoderRecoveryFailed,
      );
    });

    it('throws InvalidArgument when streamId is unknown', async () => {
      const { core } = makeCore();
      await expect(core.closeStream('s-bogus', { name: 'text', data: '' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });
  });

  describe('close', () => {
    it('auto-aborts every still-open stream with x-ably-status:aborted', async () => {
      const { core, channel } = makeCore();
      await core.startStream('s-1', { name: 'text', data: '' });
      await core.startStream('s-2', { name: 'text', data: '' });

      await core.close();

      expect(channel.appendedMessages).toHaveLength(2);
      for (const append of channel.appendedMessages) {
        expect(headersOf(append)[Headers.Status]).toBe('aborted');
      }
    });

    it('is idempotent', async () => {
      const { core } = makeCore();

      await core.close();
      await core.close();
      // No throw — the second call is a no-op.
    });

    it('rejects subsequent operations once closed', async () => {
      const { core } = makeCore();
      await core.close();

      await expect(core.publish({ name: 'text', data: 'hi' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });
});
