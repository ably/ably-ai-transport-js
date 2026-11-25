import * as Ably from '@ably/pubsub-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCodecSink } from '../../../src/core/adaptor/codec-sink.js';
import { createPipeWriter } from '../../../src/core/adaptor/pipe-writer.js';
import type { Codec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createTestCodec, type TestEvent } from '../../helper/test-codec.js';

const delta = (text: string): TestEvent => ({ type: 'text-delta', id: 't1', delta: text });

describe('a codec sink', () => {
  let channel: MockChannel;

  beforeEach(() => {
    channel = createMockChannel();
  });

  it("writes an event's messages and reports the serial it landed on and the serial of its last publish", async () => {
    const sink = createCodecSink(createTestCodec(), createPipeWriter(channel));
    await expect(sink.prepare(delta('a'), 'pipe').write()).resolves.toEqual({
      ok: true,
      serial: 'serial-1',
      publishedSerial: 'serial-1',
    });
    await expect(sink.prepare(delta('b'), 'pipe').write()).resolves.toEqual({
      ok: true,
      serial: 'serial-1',
      publishedSerial: undefined,
    });
    await expect(sink.prepare({ type: 'ping' }, 'pipe').write()).resolves.toEqual({
      ok: true,
      serial: undefined,
      publishedSerial: undefined,
    });
  });

  it('adds the headers to every message', async () => {
    const sink = createCodecSink(createTestCodec(), createPipeWriter(channel), { requestId: 'r1' });
    await sink.prepare(delta('a'), 'pipe').write();
    await sink.prepare(delta('b'), 'pipe').write();
    expect(channel.publishCalls[0]?.extras).toMatchObject({ headers: { requestId: 'r1' } });
    expect(channel.appendCalls[0]?.extras).toMatchObject({ headers: { requestId: 'r1' } });
  });

  it('encodes at prepare, and writes nothing until the prepared event is written', () => {
    const sink = createCodecSink(createTestCodec(), createPipeWriter(channel));
    sink.prepare({ type: 'note', text: 'x' }, 'pipe');
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it("throws at prepare for a message without the codec's name, naming the call", () => {
    const misnamed: Codec<TestEvent> = {
      id: 'misnamed',
      name: 'ai',
      encode: () => [{ message: { name: 'chat', data: 'x', extras: { ai: { codec: 'misnamed', type: 'note' } } } }],
      decode: () => [],
    };
    const sink = createCodecSink(misnamed, createPipeWriter(channel));
    expect(() => sink.prepare({ type: 'note', text: 'x' }, 'pipe')).toThrowErrorInfo({
      code: ErrorCode.InvalidArgument,
      message:
        "unable to pipe; codec 'misnamed' encoded a message named 'chat' with codec id 'misnamed', and its decoder only reads messages named 'ai' with codec id 'misnamed'",
    });
  });

  it("checks a prepared event against the pipe writer's key table at reserve", () => {
    const sink = createCodecSink(createTestCodec(), createPipeWriter(channel));
    const replace = sink.prepare({ type: 'text-replace', id: 't1', text: 'z' }, 'write event');
    expect(() => {
      replace.reserve();
    }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    sink.prepare(delta('a'), 'write event').reserve();
    sink.prepare({ type: 'text-replace', id: 't1', text: 'z' }, 'write event').reserve();
  });

  it('reports which write failed, with what it threw', async () => {
    const sink = createCodecSink(createTestCodec(), createPipeWriter(channel));
    const refusal = new Ably.ErrorInfo('down', 50000, 500);
    channel.publish.mockRejectedValueOnce(refusal);
    await expect(sink.prepare({ type: 'note', text: 'x' }, 'pipe').write()).resolves.toEqual({
      ok: false,
      failed: 'publish',
      error: refusal,
    });
    await sink.prepare(delta('a'), 'pipe').write();
    channel.updateMessage.mockRejectedValueOnce(refusal);
    await expect(sink.prepare({ type: 'text-replace', id: 't1', text: 'z' }, 'pipe').write()).resolves.toEqual({
      ok: false,
      failed: 'update',
      error: refusal,
    });
  });
});
