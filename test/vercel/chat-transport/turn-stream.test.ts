import * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { isTerminal, TurnStream } from '../../../src/vercel/chat-transport/turn-stream.js';
import { drain } from '../../helper/streams.js';

const start: AI.UIMessageChunk = { type: 'start' };
const textStart: AI.UIMessageChunk = { type: 'text-start', id: 't1' };
const delta: AI.UIMessageChunk = { type: 'text-delta', id: 't1', delta: 'hi' };
const finish: AI.UIMessageChunk = { type: 'finish' };

describe('isTerminal', () => {
  it('is true for the chunks that end a turn', () => {
    expect(isTerminal({ type: 'finish' })).toBe(true);
    expect(isTerminal({ type: 'abort' })).toBe(true);
    expect(isTerminal({ type: 'error', errorText: 'failed' })).toBe(true);
  });

  it('is false for every other chunk', () => {
    expect(isTerminal(start)).toBe(false);
    expect(isTerminal(delta)).toBe(false);
    expect(isTerminal({ type: 'finish-step' })).toBe(false);
  });
});

describe('TurnStream', () => {
  it('waits for its turn, reads it from the start chunk, and closes after the terminal chunk', async () => {
    const onEnd = vi.fn();
    const stream = new TurnStream(onEnd);
    expect(stream.reading).toBe(false);

    stream.write(start);
    expect(stream.reading).toBe(true);
    stream.write(textStart);
    stream.write(delta);
    stream.write(finish);

    expect(stream.ended).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(await drain(stream.readable)).toEqual([start, textStart, delta, finish]);
  });

  it('closes after an abort or error chunk as well as finish', async () => {
    const aborted = new TurnStream(vi.fn());
    aborted.write(start);
    aborted.write({ type: 'abort' });
    expect(await drain(aborted.readable)).toEqual([start, { type: 'abort' }]);

    const failed = new TurnStream(vi.fn());
    failed.write({ type: 'error', errorText: 'failed' });
    expect(await drain(failed.readable)).toEqual([{ type: 'error', errorText: 'failed' }]);
  });

  it('ignores chunks after it has ended', async () => {
    const stream = new TurnStream(vi.fn());
    stream.write(start);
    stream.write(finish);
    stream.write(delta);
    expect(await drain(stream.readable)).toEqual([start, finish]);
  });

  it('closes without a terminal chunk when closed, once, and takes no more chunks', async () => {
    const onEnd = vi.fn();
    const stream = new TurnStream(onEnd);
    stream.write(start);
    stream.write(delta);

    stream.close();
    stream.close();
    stream.write(finish);

    expect(stream.ended).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(await drain(stream.readable)).toEqual([start, delta]);
  });

  it('errors with the error it is first failed with, once', async () => {
    const onEnd = vi.fn();
    const stream = new TurnStream(onEnd);
    const reader = stream.readable.getReader();
    stream.write(start);
    expect(await reader.read()).toEqual({ done: false, value: start });

    stream.fail(new Ably.ErrorInfo('unable to read the turn; closed', ErrorCode.OperationCancelled, 400));
    stream.fail(new Ably.ErrorInfo('a second failure', ErrorCode.InternalError, 500));
    stream.write(delta);

    expect(onEnd).toHaveBeenCalledTimes(1);
    await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
  });

  it('ends when its reader cancels it, and takes no more chunks', async () => {
    const onEnd = vi.fn();
    const stream = new TurnStream(onEnd);
    stream.write(start);

    await stream.readable.cancel();
    stream.write(delta);
    stream.fail(new Ably.ErrorInfo('unable to read the turn; closed', ErrorCode.OperationCancelled, 400));

    expect(stream.ended).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
