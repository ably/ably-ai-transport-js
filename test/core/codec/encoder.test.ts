import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_MSG_ID, HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../../src/constants.js';
import { createEncoderCore } from '../../../src/core/codec/encoder.js';
import type { ChannelWriter, MessagePayload, StreamPayload } from '../../../src/core/codec/types.js';
import { ErrorCode } from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockWriter extends ChannelWriter {
  publishCalls: (Ably.Message | Ably.Message[])[];
  appendCalls: Ably.Message[];
  updateCalls: Ably.Message[];
  nextPublishResult: Ably.PublishResult;
  nextAppendResult: Ably.UpdateDeleteResult | (() => Promise<Ably.UpdateDeleteResult>);
  nextUpdateResult: Ably.UpdateDeleteResult | (() => Promise<Ably.UpdateDeleteResult>);
}

const createMockWriter = (): MockWriter => {
  const mock: MockWriter = {
    publishCalls: [],
    appendCalls: [],
    updateCalls: [],
    nextPublishResult: { serials: ['serial-1'] } as Ably.PublishResult,
    nextAppendResult: {} as Ably.UpdateDeleteResult,
    nextUpdateResult: {} as Ably.UpdateDeleteResult,
    publish: vi.fn(async (message: Ably.Message | Ably.Message[]) => {
      mock.publishCalls.push(message);
      return await Promise.resolve(mock.nextPublishResult);
    }),
    appendMessage: vi.fn(async (message: Ably.Message) => {
      mock.appendCalls.push(message);
      if (typeof mock.nextAppendResult === 'function') {
        return await mock.nextAppendResult();
      }
      return await Promise.resolve(mock.nextAppendResult);
    }),
    updateMessage: vi.fn(async (message: Ably.Message) => {
      mock.updateCalls.push(message);
      if (typeof mock.nextUpdateResult === 'function') {
        return await mock.nextUpdateResult();
      }
      return await Promise.resolve(mock.nextUpdateResult);
    }),
  };

  return mock;
};

/**
 * Extract headers from an Ably.Message extras.
 * @param msg - The Ably message.
 * @returns The headers record.
 */
const headersOf = (msg: Ably.Message): Record<string, string> =>
  (msg.extras as { headers: Record<string, string> }).headers;

/**
 * Get first element of an array, throwing if absent.
 * @param arr - The array to read from.
 * @returns The first element.
 */
const first = <T>(arr: T[]): T => {
  const item = arr[0];
  if (item === undefined) throw new Error('expected at least one element');
  return item;
};

const payload = (overrides: Partial<MessagePayload> = {}): MessagePayload => ({
  name: 'test',
  data: '',
  ...overrides,
});

const streamPayload = (overrides: Partial<StreamPayload> = {}): StreamPayload => ({
  name: 'test',
  data: '',
  ...overrides,
});

// ---------------------------------------------------------------------------
// createEncoderCore
// ---------------------------------------------------------------------------

describe('createEncoderCore', () => {
  let writer: MockWriter;

  beforeEach(() => {
    writer = createMockWriter();
  });

  // -- publishDiscrete -----------------------------------------------------

  describe('publishDiscrete', () => {
    it('publishes with x-ably-stream:false and codec headers', async () => {
      const core = createEncoderCore(writer);
      const result = await core.publishDiscrete(
        payload({ name: 'event', data: 'payload', headers: { 'x-custom': 'val' } }),
      );
      expect(result).toEqual({ serials: ['serial-1'] });

      const msg = first(writer.publishCalls) as Ably.Message;
      expect(msg.name).toBe('event');
      expect(msg.data).toBe('payload');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(headersOf(msg)['x-custom']).toBe('val');
    });

    it('includes clientId from options', async () => {
      const core = createEncoderCore(writer, { clientId: 'user-1' });
      await core.publishDiscrete(payload());
      expect((first(writer.publishCalls) as Ably.Message).clientId).toBe('user-1');
    });

    it('per-write clientId overrides default', async () => {
      const core = createEncoderCore(writer, { clientId: 'default' });
      await core.publishDiscrete(payload(), { clientId: 'override' });
      expect((first(writer.publishCalls) as Ably.Message).clientId).toBe('override');
    });

    it('calls onMessage hook', async () => {
      const hook = vi.fn();
      const core = createEncoderCore(writer, { onMessage: hook });
      await core.publishDiscrete(payload());
      expect(hook).toHaveBeenCalledOnce();
    });

    it('sets ephemeral flag in extras', async () => {
      const core = createEncoderCore(writer);
      await core.publishDiscrete(payload({ ephemeral: true }));
      const msg = first(writer.publishCalls) as Ably.Message;
      // CAST: Ably SDK types `extras` as `any`; we know it contains `ephemeral` when set.
      const extras = msg.extras as { ephemeral?: boolean };
      expect(extras.ephemeral).toBe(true);
    });

    it('merges default and codec headers', async () => {
      const core = createEncoderCore(writer, { extras: { headers: { default: 'val' } } });
      await core.publishDiscrete(payload({ headers: { codec: 'val2' } }));
      const headers = headersOf(first(writer.publishCalls) as Ably.Message);
      expect(headers.default).toBe('val');
      expect(headers.codec).toBe('val2');
    });

    it('works without explicit headers on payload', async () => {
      const core = createEncoderCore(writer);
      await core.publishDiscrete(payload());
      expect(headersOf(first(writer.publishCalls) as Ably.Message)[HEADER_STREAM]).toBe('false');
    });

    it('throws after close', async () => {
      const core = createEncoderCore(writer);
      await core.close();
      await expect(core.publishDiscrete(payload())).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- publishDiscreteBatch ------------------------------------------------

  describe('publishDiscreteBatch', () => {
    it('publishes multiple messages in a single call with correct headers', async () => {
      const core = createEncoderCore(writer);
      await core.publishDiscreteBatch([payload({ name: 'a', data: '1' }), payload({ name: 'b', data: '2' })]);

      expect(writer.publishCalls).toHaveLength(1);
      const batch = first(writer.publishCalls) as Ably.Message[];
      expect(batch).toHaveLength(2);
      expect(batch[0]?.name).toBe('a');
      expect(batch[1]?.name).toBe('b');
      for (const msg of batch) {
        expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      }
    });

    it('throws after close', async () => {
      const core = createEncoderCore(writer);
      await core.close();
      await expect(core.publishDiscreteBatch([payload()])).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- startStream ---------------------------------------------------------

  describe('startStream', () => {
    it('publishes a mutable message with streaming status', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text', headers: { 'x-id': '123' } }));

      const msg = first(writer.publishCalls) as Ably.Message;
      expect(headersOf(msg)[HEADER_STREAM]).toBe('true');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('streaming');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('s1');
      expect(headersOf(msg)['x-id']).toBe('123');
    });

    it('throws when no serial returned', async () => {
      writer.nextPublishResult = { serials: [] } as unknown as Ably.PublishResult;
      const core = createEncoderCore(writer);
      await expect(core.startStream('s1', streamPayload({ name: 'text' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.BadRequest,
      );
    });

    it('throws after close', async () => {
      const core = createEncoderCore(writer);
      await core.close();
      await expect(core.startStream('s1', streamPayload())).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- appendStream --------------------------------------------------------

  describe('appendStream', () => {
    it('appends string delta to an active stream', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));

      core.appendStream('s1', 'hello');
      const msg = first(writer.appendCalls);
      expect(msg.data).toBe('hello');
      expect(msg.serial).toBe('serial-1');
    });

    it('throws for unknown streamId', () => {
      const core = createEncoderCore(writer);
      expect(() => {
        core.appendStream('nonexistent', 'data');
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('throws after close', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      await core.close();
      expect(() => {
        core.appendStream('s1', 'data');
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- closeStream ---------------------------------------------------------

  describe('closeStream', () => {
    it('appends with finished status', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      await core.closeStream('s1', streamPayload({ name: 'text' }));

      expect(headersOf(first(writer.appendCalls))[HEADER_STATUS]).toBe('finished');
    });

    it('repeats persistent headers on close', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text', headers: { 'x-custom': 'keep' } }));
      await core.closeStream('s1', streamPayload({ name: 'text' }));

      expect(headersOf(first(writer.appendCalls))['x-custom']).toBe('keep');
    });

    it('merges payload headers on close', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      await core.closeStream('s1', streamPayload({ name: 'text', headers: { 'x-finish': 'yes' } }));

      expect(headersOf(first(writer.appendCalls))['x-finish']).toBe('yes');
    });

    it('rejects for unknown streamId', async () => {
      const core = createEncoderCore(writer);
      await expect(core.closeStream('nonexistent', streamPayload())).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });

    it('rejects after close', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      await core.close();
      await expect(core.closeStream('s1', streamPayload())).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- abortStream ---------------------------------------------------------

  describe('abortStream', () => {
    it('sends aborted status for the specified stream', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      await core.abortStream('s1');

      expect(writer.appendCalls).toHaveLength(1);
      expect(headersOf(first(writer.appendCalls))[HEADER_STATUS]).toBe('aborted');
    });

    it('only aborts the specified stream, not others', async () => {
      writer.nextPublishResult = { serials: ['serial-1'] } as Ably.PublishResult;
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));

      writer.nextPublishResult = { serials: ['serial-2'] } as Ably.PublishResult;
      await core.startStream('s2', streamPayload({ name: 'reasoning' }));

      await core.abortStream('s1');

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.serial).toBe('serial-1');
    });

    it('rejects for unknown streamId', async () => {
      const core = createEncoderCore(writer);
      await expect(core.abortStream('nonexistent')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('rejects after close', async () => {
      const core = createEncoderCore(writer);
      await core.close();
      await expect(core.abortStream('s1')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- abortAllStreams -----------------------------------------------------

  describe('abortAllStreams', () => {
    it('sends aborted status for all active streams', async () => {
      writer.nextPublishResult = { serials: ['serial-1'] } as Ably.PublishResult;
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));

      writer.nextPublishResult = { serials: ['serial-2'] } as Ably.PublishResult;
      await core.startStream('s2', streamPayload({ name: 'reasoning' }));

      await core.abortAllStreams();

      expect(writer.appendCalls).toHaveLength(2);
      for (const msg of writer.appendCalls) {
        expect(headersOf(msg)[HEADER_STATUS]).toBe('aborted');
      }
    });

    it('is a no-op with no active streams', async () => {
      const core = createEncoderCore(writer);
      await core.abortAllStreams();
      expect(writer.appendCalls).toHaveLength(0);
    });

    it('rejects after close', async () => {
      const core = createEncoderCore(writer);
      await core.close();
      await expect(core.abortAllStreams()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- recovery (via closeStream / abortAllStreams) ------------------------

  describe('recovery', () => {
    it('closeStream flushes pending appends', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      core.appendStream('s1', 'a');
      core.appendStream('s1', 'b');

      await core.closeStream('s1', streamPayload({ name: 'text' }));

      // 2 appends + 1 closing append
      expect(writer.appendCalls).toHaveLength(3);
      expect(writer.appendCalls[0]?.data).toBe('a');
      expect(writer.appendCalls[1]?.data).toBe('b');
    });

    it('closeStream recovers failed append with full accumulated text via updateMessage', async () => {
      let callCount = 0;
      writer.nextAppendResult = async () => {
        callCount++;
        if (callCount === 2) return await Promise.reject(new Error('network'));
        return {} as Ably.UpdateDeleteResult;
      };

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      core.appendStream('s1', 'hello');
      core.appendStream('s1', ' world');

      await core.closeStream('s1', streamPayload({ name: 'text' }));

      const recovery = first(writer.updateCalls);
      expect(recovery.data).toBe('hello world');
      expect(headersOf(recovery)[HEADER_STATUS]).toBe('finished');
    });

    it('recovery message includes initial startStream data in accumulation', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('fail'));

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text', data: 'prefix-' }));
      core.appendStream('s1', 'suffix');

      await core.closeStream('s1', streamPayload({ name: 'text' }));

      expect(first(writer.updateCalls).data).toBe('prefix-suffix');
    });

    it('recovery message preserves persistent headers and serial', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('fail'));

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text', headers: { 'x-codec': 'val' } }));
      core.appendStream('s1', 'data');

      await core.closeStream('s1', streamPayload({ name: 'text' }));

      const recovery = first(writer.updateCalls);
      expect(recovery.serial).toBe('serial-1');
      expect(headersOf(recovery)['x-codec']).toBe('val');
      expect(headersOf(recovery)[HEADER_STREAM]).toBe('true');
    });

    it('abortAllStreams uses aborted status in recovery', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('fail'));

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      core.appendStream('s1', 'data');

      await core.abortAllStreams();

      expect(headersOf(first(writer.updateCalls))[HEADER_STATUS]).toBe('aborted');
    });

    it('closeStream throws when recovery also fails', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('append fail'));
      writer.nextUpdateResult = async () => await Promise.reject(new Error('update fail'));

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      core.appendStream('s1', 'data');

      await expect(core.closeStream('s1', streamPayload({ name: 'text' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.EncoderRecoveryFailed,
      );
    });

    it('abortAllStreams recovers multiple failed streams independently', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('fail'));

      const core = createEncoderCore(writer);
      writer.nextPublishResult = { serials: ['s1'] } as Ably.PublishResult;
      await core.startStream('stream-1', streamPayload({ name: 'text' }));
      writer.nextPublishResult = { serials: ['s2'] } as Ably.PublishResult;
      await core.startStream('stream-2', streamPayload({ name: 'reasoning' }));

      core.appendStream('stream-1', 'text-data');
      core.appendStream('stream-2', 'reason-data');

      await core.abortAllStreams();

      expect(writer.updateCalls).toHaveLength(2);
    });

    it('closeStream includes closing data in recovery accumulation', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('fail'));

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      core.appendStream('s1', 'hello');

      await core.closeStream('s1', streamPayload({ name: 'text', data: ' world' }));

      const recovery = first(writer.updateCalls);
      expect(recovery.data).toBe('hello world');
      expect(headersOf(recovery)[HEADER_STATUS]).toBe('finished');
    });
  });

  // -- close ---------------------------------------------------------------

  describe('close', () => {
    it('is idempotent', async () => {
      const core = createEncoderCore(writer);
      await core.close();
      await core.close();
    });

    it('clears trackers even when flush fails', async () => {
      writer.nextAppendResult = async () => await Promise.reject(new Error('fail'));
      writer.nextUpdateResult = async () => await Promise.reject(new Error('fail'));

      const core = createEncoderCore(writer);
      await core.startStream('s1', streamPayload({ name: 'text' }));
      core.appendStream('s1', 'data');

      await expect(core.close()).rejects.toBeErrorInfoWithCode(ErrorCode.EncoderRecoveryFailed);

      // Encoder should still be closed — further writes throw InvalidArgument
      await expect(core.publishDiscrete(payload())).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -- onMessage hook isolation --------------------------------------------

  describe('onMessage hook isolation', () => {
    it('does not propagate errors from onMessage hook', async () => {
      const core = createEncoderCore(writer, {
        onMessage: () => {
          throw new Error('hook error');
        },
      });

      await core.publishDiscrete(payload());
      expect(writer.publishCalls).toHaveLength(1);
    });
  });

  // -- WriteOptions.messageId -------------------------------------------------

  describe('WriteOptions.messageId', () => {
    it('stamps x-ably-msg-id on discrete publishes', async () => {
      const core = createEncoderCore(writer);
      await core.publishDiscrete(payload(), { messageId: 'msg-1' });

      const msg = first(writer.publishCalls) as Ably.Message;
      expect(headersOf(msg)[HEADER_MSG_ID]).toBe('msg-1');
    });

    it('stamps x-ably-msg-id on streamed messages via persistent headers', async () => {
      const core = createEncoderCore(writer);
      await core.startStream('s-1', streamPayload(), { messageId: 'msg-2' });

      const startMsg = first(writer.publishCalls) as Ably.Message;
      expect(headersOf(startMsg)[HEADER_MSG_ID]).toBe('msg-2');

      // Appends carry persistent headers, so should include msg-id
      core.appendStream('s-1', 'delta');
      const appendMsg = first(writer.appendCalls);
      expect(headersOf(appendMsg)[HEADER_MSG_ID]).toBe('msg-2');
    });

    it('does not stamp x-ably-msg-id when messageId is not provided', async () => {
      const core = createEncoderCore(writer);
      await core.publishDiscrete(payload());

      const msg = first(writer.publishCalls) as Ably.Message;
      expect(headersOf(msg)[HEADER_MSG_ID]).toBeUndefined();
    });
  });
});
