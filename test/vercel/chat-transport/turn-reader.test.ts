import * as Ably from '@ably/pubsub-core';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { TurnReader } from '../../../src/vercel/chat-transport/turn-reader.js';
import { TurnStream } from '../../../src/vercel/chat-transport/turn-stream.js';
import { silentLogger } from '../../helper/logger.js';
import { drain, nextMacrotask } from '../../helper/streams.js';
import {
  type ChannelFixture,
  channelWith,
  failedToStart,
  failedTurn,
  gate,
  paginated,
  textTurn,
  wireAcross,
  wireOf,
} from './fixtures.js';

/**
 * A reader on the fixture's channel, as the chat transport opens one.
 * @param fixture - The channel to read.
 * @returns The reader.
 */
const readerOn = (fixture: ChannelFixture): TurnReader =>
  new TurnReader({ channel: fixture.channel, logger: silentLogger });

/**
 * A logger that records the messages it is asked to log at warn level and
 * above.
 * @returns The logger and the messages it recorded.
 */
const warningLogger = (): { logger: ReturnType<typeof makeLogger>; warnings: string[] } => {
  const warnings: string[] = [];
  const logger = makeLogger({
    logLevel: LogLevel.Warn,
    logHandler: (message: string) => {
      warnings.push(message);
    },
  });
  return { logger, warnings };
};

/**
 * A reader that read the channel and is closing, its detach held until the
 * test lets it finish.
 * @param fixture - The channel.
 * @returns Lets the detach finish.
 */
const readerClosing = async (fixture: ChannelFixture): Promise<() => void> => {
  const previous = readerOn(fixture);
  await previous.ready;
  const detaching = gate();
  fixture.channel.detach.mockReturnValueOnce(detaching.promise);
  // Not awaited: it never rejects, and the gate holds its detach.
  void previous.close();
  return detaching.open;
};

/**
 * A stream that records how often it ended.
 * @returns The stream and the count.
 */
const recordingStream = (): { stream: TurnStream; ends: () => number } => {
  let ends = 0;
  const stream = new TurnStream(() => {
    ends += 1;
  });
  return { stream, ends: () => ends };
};

const first = textTurn('t1', ['Hel', 'lo']);
const second = textTurn('t2', ['Bye']);

describe('TurnReader', () => {
  describe('when it opens', () => {
    it('knows a turn that was running before it attached, from its start chunk', async () => {
      const running = first.slice(0, 3);
      const fixture = channelWith(wireOf(running).stored);
      const reader = readerOn(fixture);
      await reader.ready;

      expect(reader.latest?.ended).toBe(false);
      expect(reader.latest?.chunks).toEqual(running);
    });

    it('knows the latest turn has ended when its terminal chunk is in history', async () => {
      const fixture = channelWith(wireOf([...first, ...second]).stored);
      const reader = readerOn(fixture);
      await reader.ready;

      expect(reader.latest?.ended).toBe(true);
      expect(reader.latest?.chunks).toEqual(second);
    });

    it('knows no turn on a channel with none', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;

      expect(reader.latest).toBeUndefined();
    });

    it('subscribes only once the previous reader on the channel has detached it', async () => {
      const fixture = channelWith();
      const detached = await readerClosing(fixture);

      const reader = readerOn(fixture);
      await nextMacrotask();
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(1);

      detached();
      await reader.ready;
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    });

    it('waits for every earlier reader still closing on the channel, not only the latest', async () => {
      const fixture = channelWith();
      const detached = await readerClosing(fixture);
      // Not awaited: it never rejects. It closes before it ever subscribed.
      void readerOn(fixture).close();

      const reader = readerOn(fixture);
      await nextMacrotask();
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(1);

      detached();
      await reader.ready;
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(2);
    });

    it('stays fresh through the previous reader’s detach and its own first attach', async () => {
      const fixture = channelWith();
      const previous = readerOn(fixture);
      await previous.ready;
      // Not awaited: it never rejects, and the next reader waits for it.
      void previous.close();

      const reader = readerOn(fixture);
      await reader.ready;

      expect(fixture.channel.state).toBe('attached');
      expect(reader.stale).toBe(false);
    });

    it('rejects ready with the attach’s own code, goes stale and stops listening, when the channel cannot be attached', async () => {
      const fixture = channelWith();
      fixture.channel.attach.mockRejectedValue(new Ably.ErrorInfo('channel failed', 90000, 400));
      const reader = readerOn(fixture);

      await expect(reader.ready).rejects.toBeErrorInfo({
        code: 90000,
        statusCode: 400,
        message: 'unable to read the channel; channel failed',
        cause: { message: 'channel failed' },
      });
      expect(reader.stale).toBe(true);
      expect(fixture.channel.listener).toBeUndefined();
    });

    it('rejects ready with the history read’s own code when history cannot be read', async () => {
      const fixture = channelWith();
      fixture.channel.history.mockRejectedValue(new Ably.ErrorInfo('history unavailable', 50000, 500));
      const reader = readerOn(fixture);

      await expect(reader.ready).rejects.toBeErrorInfo({
        code: 50000,
        statusCode: 500,
        message: 'unable to read the channel; history unavailable',
        cause: { message: 'history unavailable' },
      });
      expect(reader.stale).toBe(true);
    });

    it('keeps the status of a failure ably-js reports with no code, such as a history request that timed out', async () => {
      const fixture = channelWith();
      // eslint-disable-next-line unicorn/no-null -- ably-js reports a timed-out request with a null code
      fixture.channel.history.mockRejectedValue(new Ably.PartialErrorInfo('Request timed out', null, 408));
      const reader = readerOn(fixture);

      await expect(reader.ready).rejects.toBeErrorInfo({
        code: ErrorCode.InternalError,
        statusCode: 408,
        message: 'unable to read the channel; Request timed out',
        cause: { message: 'Request timed out', statusCode: 408 },
      });
    });

    it('rejects ready with InternalError when the failure carries no code', async () => {
      const fixture = channelWith();
      fixture.channel.history.mockRejectedValue(new TypeError('the page was malformed'));
      const reader = readerOn(fixture);

      await expect(reader.ready).rejects.toBeErrorInfo({
        code: ErrorCode.InternalError,
        statusCode: 500,
        message: 'unable to read the channel; the page was malformed',
      });
    });

    it('leaves no unhandled rejection when it closes before anything waited for it', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        await readerOn(channelWith()).close();
        await nextMacrotask();

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  describe('as turns arrive live', () => {
    it('replaces the latest turn on each start chunk and marks it ended on its terminal chunk', async () => {
      const wire = wireAcross(first, second);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;

      fixture.deliver(wire.live.slice(0, 2));
      expect(reader.latest?.chunks).toEqual(second.slice(0, 2));
      expect(reader.latest?.ended).toBe(false);

      fixture.deliver(wire.live.slice(2));
      expect(reader.latest?.chunks).toEqual(second);
      expect(reader.latest?.ended).toBe(true);
      expect(reader.latest?.startSerial).toBe(wire.live[0]?.serial);
    });

    it('passes over a prompt and anything the codec has nothing for', async () => {
      const prompt: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      const wire = wireOf([{ type: 'user-message', message: prompt }, ...first]);
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.waitForNextTurn(stream);

      // CAST: a foreign publish on the shared channel, with no `extras.ai`.
      const foreign = { name: 'cancel', data: {}, serial: 's9999', action: 'message.create' } as Ably.InboundMessage;
      fixture.deliver([wire.live[0], foreign, ...wire.live.slice(1)].filter((m) => m !== undefined));

      expect(await drain(stream.readable)).toEqual(first);
    });

    it('keeps a prompt published mid-turn out of the turn', async () => {
      const prompt: AI.UIMessage = { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and?' }] };
      const wire = wireAcross(first.slice(0, 3), [
        ...first.slice(3, 4),
        { type: 'user-message', message: prompt },
        ...first.slice(4),
      ]);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.joinLatestTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual(first);
    });

    it('marks a turn ended when its terminal chunk arrives, even an error', async () => {
      const failing = failedTurn('t1', 'Hel');
      const wire = wireAcross(failing.slice(0, 3), failing.slice(3));
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const turn = reader.latest;
      expect(turn?.ended).toBe(false);

      fixture.deliver(wire.live.slice(0, 1));

      expect(turn?.ended).toBe(true);
    });

    it('warns of a chunk written outside any turn, but not of what the AI SDK writes after an error', async () => {
      const { logger, warnings } = warningLogger();
      const fixture = channelWith();
      const reader = new TurnReader({ channel: fixture.channel, logger });
      await reader.ready;

      fixture.deliver(wireOf([...failedTurn('t1', 'Hel'), ...second, { type: 'finish' }]).live);

      expect(warnings).toEqual(['TurnReader._receive(); passing over a chunk written outside any turn']);
    });

    it('fails the streams reading the turn with SessionMessageProcessingFailed when one of its messages cannot be decoded', async () => {
      const wire = wireAcross(first.slice(0, 3), first.slice(3));
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const reading = recordingStream();
      reader.joinLatestTurn(reading.stream);
      const waiting = recordingStream();
      reader.waitForNextTurn(waiting.stream);

      // CAST: the turn's last message, its data replaced with what its row cannot decode.
      fixture.deliver([{ ...wire.live.at(-1), data: 'not an object' } as Ably.InboundMessage]);

      await expect(drain(reading.stream.readable)).rejects.toBeErrorInfoWithCode(
        ErrorCode.SessionMessageProcessingFailed,
      );
      expect(waiting.ends()).toBe(0);
    });

    it('ends no stream when a message that cannot be decoded arrives while no turn runs', async () => {
      const wire = wireAcross(first, second);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const waiting = recordingStream();
      reader.waitForNextTurn(waiting.stream);

      // CAST: a message of the next turn, its data replaced with what its row cannot decode.
      fixture.deliver([{ ...wire.live.at(-1), data: 'not an object' } as Ably.InboundMessage]);
      fixture.deliver(wire.live);

      expect(await drain(waiting.stream.readable)).toEqual(second);
    });
  });

  describe('waitForNextTurn and joinLatestTurn', () => {
    it('starts a waiting stream at the next start chunk and ends it at that turn’s terminal chunk', async () => {
      const wire = wireOf(first);
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream, ends } = recordingStream();
      reader.waitForNextTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual(first);
      expect(ends()).toBe(1);
    });

    it('keeps a turn that was already running out of a waiting stream', async () => {
      const stopped = textTurn('t1', ['Hel', 'lo', ' there'], 'abort');
      // The reader has seen the stopped turn start; its tail and its abort
      // arrive after the stream started waiting, then the next turn begins.
      const wire = wireAcross(stopped.slice(0, 3), [...stopped.slice(3), ...second]);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.waitForNextTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual(second);
    });

    it('ends a waiting stream on an error that arrives while no turn is running', async () => {
      const wire = wireAcross(first, [failedToStart]);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.waitForNextTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual([failedToStart]);
    });

    it('passes over the finish the AI SDK writes after an error, and any chunk with no turn running', async () => {
      const failing = failedTurn('t1', 'Hel');
      // A retry starts waiting once the error has ended the turn, before the
      // chunks that trail it arrive.
      const wire = wireAcross(failing.slice(0, 4), [
        ...failing.slice(4),
        { type: 'abort' },
        { type: 'text-delta', id: 't1', delta: ' late' },
        ...second,
      ]);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      expect(reader.latest?.ended).toBe(true);
      const { stream } = recordingStream();
      reader.waitForNextTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual(second);
    });

    it('ends the streams reading a turn when the next one starts before it ended', async () => {
      const dead = first.slice(0, 3);
      const wire = wireAcross(dead, second);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const reading = recordingStream();
      reader.joinLatestTurn(reading.stream);
      const waiting = recordingStream();
      reader.waitForNextTurn(waiting.stream);

      fixture.deliver(wire.live);

      expect(await drain(reading.stream.readable)).toEqual(dead);
      expect(reading.ends()).toBe(1);
      expect(await drain(waiting.stream.readable)).toEqual(second);
    });

    it('replays the latest turn to a joining stream, then follows it live', async () => {
      const wire = wireAcross(first.slice(0, 3), first.slice(3));
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.joinLatestTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual(first);
    });

    it('ends a stream at once when the turn it replays has ended, and stops following it', async () => {
      const wire = wireAcross(first, second);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream, ends } = recordingStream();
      reader.joinLatestTurn(stream);

      fixture.deliver(wire.live);

      // History holds a streamed text part as one message, so its deltas come
      // back joined.
      expect(await drain(stream.readable)).toEqual([
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ]);
      expect(ends()).toBe(1);
    });

    it('stops handing chunks to a stream that was unfollowed', async () => {
      const wire = wireOf(first);
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream, ends } = recordingStream();
      reader.waitForNextTurn(stream);

      fixture.deliver(wire.live.slice(0, 2));
      reader.unfollow(stream);
      fixture.deliver(wire.live.slice(2));

      // The terminal chunk never reached the stream, so it is still open.
      expect(stream.reading).toBe(true);
      expect(ends()).toBe(0);
    });

    it('ends a stream with OperationCancelled when the reader has closed', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      await reader.close();
      const waiting = recordingStream();
      const joining = recordingStream();

      reader.waitForNextTurn(waiting.stream);
      reader.joinLatestTurn(joining.stream);

      await expect(drain(waiting.stream.readable)).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      await expect(drain(joining.stream.readable)).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    });
  });

  describe('reading history', () => {
    it('subscribes, attaches the channel, then reads history back to where it attached', async () => {
      const fixture = channelWith();
      await readerOn(fixture).ready;

      const [subscribed] = fixture.channel.subscribe.mock.invocationCallOrder;
      const [attached] = fixture.channel.attach.mock.invocationCallOrder;
      const [read] = fixture.channel.history.mock.invocationCallOrder;
      expect(subscribed).toBeLessThan(attached ?? 0);
      expect(attached).toBeLessThan(read ?? 0);
      expect(fixture.channel.history).toHaveBeenCalledWith({ untilAttach: true });
    });

    it('pages back to the newest start chunk, across pages', async () => {
      const running = second.slice(0, 3);
      const fixture = channelWith(wireOf([...first, ...running]).stored, 2);
      const reader = readerOn(fixture);
      await reader.ready;

      expect(reader.latest?.chunks).toEqual(running);
      expect(reader.latest?.ended).toBe(false);
    });

    it('reads no page past the one that holds the newest start chunk', async () => {
      const fixture = channelWith();
      // eslint-disable-next-line @typescript-eslint/require-await -- the mock rejects, as a page the reader must not read would
      const next = vi.fn(async (): Promise<never> => {
        throw new Error('read past the newest start chunk');
      });
      // CAST: the reader reads only `items`, `hasNext()` and `next()`.
      const page = {
        items: wireOf(first).stored.toReversed(),
        hasNext: () => true,
        next,
      } as unknown as Ably.PaginatedResult<Ably.InboundMessage>;
      fixture.channel.history.mockResolvedValueOnce(page);
      const reader = readerOn(fixture);

      await reader.ready;

      expect(next).not.toHaveBeenCalled();
      expect(reader.latest?.ended).toBe(true);
    });

    it('holds what arrives live while history is read, and takes it, in order, once history has been', async () => {
      const wire = wireAcross(first.slice(0, 3), first.slice(3));
      const fixture = channelWith();
      const page = Promise.withResolvers<Ably.PaginatedResult<Ably.InboundMessage>>();
      fixture.channel.history.mockReturnValueOnce(page.promise);
      const reader = readerOn(fixture);
      await nextMacrotask();

      fixture.deliver(wire.live);
      page.resolve(paginated([wire.stored.toReversed()]));
      await reader.ready;

      expect(reader.latest?.chunks).toEqual(first);
      expect(reader.latest?.ended).toBe(true);
    });

    it('knows no turn when history holds chunks but no start chunk', async () => {
      const fixture = channelWith(wireOf(first.slice(1)).stored);
      const reader = readerOn(fixture);
      await reader.ready;

      expect(reader.latest).toBeUndefined();
    });

    it('only logs a message from history that cannot be decoded, and a reply that rejoins goes on without it', async () => {
      const errors: string[] = [];
      const logger = makeLogger({
        logLevel: LogLevel.Error,
        logHandler: (message: string) => {
          errors.push(message);
        },
      });
      const wire = wireAcross(first.slice(0, 3), first.slice(3));
      // The stored text-start message, its data replaced with what its row cannot decode.
      const stored = wire.stored.map((message, index) =>
        index === 1 ? { ...message, data: 'not an object' } : message,
      );
      const fixture = channelWith(stored);
      const reader = new TurnReader({ channel: fixture.channel, logger });
      await reader.ready;
      const { stream } = recordingStream();
      reader.joinLatestTurn(stream);

      fixture.deliver(wire.live);

      expect(await drain(stream.readable)).toEqual(first.filter((chunk) => chunk.type !== 'text-start'));
      expect(errors).toEqual(['DefaultDecoder.decode(); decode failed, delivering the message without an event']);
    });
  });

  describe('the channel', () => {
    it('makes the reader stale once the channel loses continuity', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      expect(reader.stale).toBe(false);

      fixture.channel.emitStateChange({ current: 'attached', previous: 'attaching', resumed: false });

      expect(reader.stale).toBe(true);
    });

    it.each<[string, Ably.ChannelStateChange, boolean]>([
      ['FAILED', { current: 'failed', previous: 'attached', resumed: false }, true],
      ['SUSPENDED', { current: 'suspended', previous: 'attached', resumed: false }, true],
      ['DETACHED', { current: 'detached', previous: 'detaching', resumed: false }, true],
      ['an UPDATE that lost messages', { current: 'attached', previous: 'attached', resumed: false }, true],
      ['an UPDATE that lost nothing', { current: 'attached', previous: 'attached', resumed: true }, false],
      ['ATTACHED, resumed', { current: 'attached', previous: 'attaching', resumed: true }, false],
      ['ATTACHING', { current: 'attaching', previous: 'suspended', resumed: false }, false],
    ])('takes %s after the first attach as a loss of continuity: %s', async (_name, stateChange, lost) => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;

      fixture.channel.emitStateChange(stateChange);

      expect(reader.stale).toBe(lost);
    });

    it('takes no state change before the channel first attaches as a loss', async () => {
      const fixture = channelWith();
      // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
      fixture.channel.attach.mockImplementationOnce(async () => {
        fixture.channel.emitStateChange({ current: 'suspended', previous: 'attaching', resumed: false });
        fixture.channel.state = 'attached';
        fixture.channel.emitStateChange({ current: 'attached', previous: 'suspended', resumed: false });
        // eslint-disable-next-line unicorn/no-null -- ably-js resolves attach with null when it changed nothing
        return null;
      });
      const reader = readerOn(fixture);
      await reader.ready;

      expect(reader.stale).toBe(false);
    });

    it('warns when the channel was attached before the reader subscribed, and only then', async () => {
      const { logger, warnings } = warningLogger();
      const attached = channelWith();
      attached.channel.state = 'attached';
      await new TurnReader({ channel: attached.channel, logger }).ready;
      await new TurnReader({ channel: channelWith().channel, logger }).ready;

      expect(warnings).toEqual([
        'TurnReader._start(); the channel was attached before the reader, so its history starts there',
      ]);
    });
  });

  describe('close', () => {
    it('ends the streams still following with OperationCancelled, unsubscribes and detaches the channel', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.waitForNextTurn(stream);

      await reader.close();

      await expect(stream.readable.getReader().read()).rejects.toBeErrorInfo({
        code: ErrorCode.OperationCancelled,
        message: 'unable to read the turn; the chat transport was closed',
      });
      expect(fixture.channel.listener).toBeUndefined();
      expect(fixture.channel.off).toHaveBeenCalledTimes(1);
      expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
    });

    it.each<Ably.ChannelState>(['suspended', 'failed'])(
      'leaves a channel it found %s, which something else attached, to the application',
      async (state) => {
        const fixture = channelWith();
        fixture.channel.state = state;
        const reader = readerOn(fixture);
        await reader.ready;

        await reader.close();

        expect(fixture.channel.listener).toBeUndefined();
        expect(fixture.channel.detach).not.toHaveBeenCalled();
      },
    );

    it('leaves a channel the application attached attached, and only stops listening', async () => {
      const fixture = channelWith();
      fixture.channel.state = 'attached';
      const reader = readerOn(fixture);
      await reader.ready;

      await reader.close();

      expect(fixture.channel.listener).toBeUndefined();
      expect(fixture.channel.detach).not.toHaveBeenCalled();
      expect(fixture.channel.state).toBe('attached');
    });

    it('ends the streams with the reason it was given', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      const { stream } = recordingStream();
      reader.waitForNextTurn(stream);

      await reader.close('the channel lost continuity, and a later call read it again');

      await expect(drain(stream.readable)).rejects.toBeErrorInfo({
        code: ErrorCode.OperationCancelled,
        message: 'unable to read the turn; the channel lost continuity, and a later call read it again',
      });
    });

    it('rejects ready with OperationCancelled when it closes before history has been read', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);

      await reader.close();

      await expect(reader.ready).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    });

    it('attaches nothing, and leaves no listener, when it closes while it subscribes', async () => {
      const fixture = channelWith();
      const subscribing = gate();
      fixture.channel.subscribe.mockImplementationOnce(async (listener) => {
        fixture.channel.listener = listener;
        await subscribing.promise;
        // eslint-disable-next-line unicorn/no-null -- ably-js resolves subscribe with null when the attach changed nothing
        return null;
      });
      const reader = readerOn(fixture);
      await nextMacrotask();

      const closing = reader.close();
      subscribing.open();
      await closing;

      await expect(reader.ready).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(fixture.channel.attach).not.toHaveBeenCalled();
      expect(fixture.channel.listener).toBeUndefined();
      expect(fixture.channel.state).toBe('initialized');
    });

    it('rejects ready with OperationCancelled, named AbortError, when it closes while history is read', async () => {
      const fixture = channelWith();
      const page = Promise.withResolvers<Ably.PaginatedResult<Ably.InboundMessage>>();
      fixture.channel.history.mockReturnValueOnce(page.promise);
      const reader = readerOn(fixture);
      await nextMacrotask();
      expect(fixture.channel.history).toHaveBeenCalledTimes(1);

      const closing = reader.close();
      page.resolve(paginated([]));

      await expect(reader.ready).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      await expect(reader.ready).rejects.toHaveProperty('name', 'AbortError');
      await closing;
    });

    it('never subscribes when it closes while the previous reader is still closing', async () => {
      const fixture = channelWith();
      const detached = await readerClosing(fixture);
      const reader = readerOn(fixture);

      const closing = reader.close();
      detached();
      await closing;

      await expect(reader.ready).rejects.toBeErrorInfo({ code: ErrorCode.OperationCancelled });
      expect(fixture.channel.subscribe).toHaveBeenCalledTimes(1);
      expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
    });

    it('is safe to call twice', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;

      await reader.close();
      await reader.close();

      expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
    });
  });
});
