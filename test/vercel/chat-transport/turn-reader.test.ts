import * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { TurnReader } from '../../../src/vercel/chat-transport/turn-reader.js';
import { TurnStream } from '../../../src/vercel/chat-transport/turn-stream.js';
import { silentLogger } from '../../helper/logger.js';
import { makePaginated } from '../../helper/mock-channel.js';
import { drain, flushMicrotasks, nextMacrotask } from '../../helper/streams.js';
import {
  type ChannelFixture,
  channelWith,
  failedToStart,
  failedTurn,
  gate,
  movingThroughStates,
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
  new TurnReader({ client: fixture.client, channel: fixture.channel, logger: silentLogger });

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

/**
 * Whether a promise has settled, without waiting for it.
 * @param promise - The promise.
 * @returns Resolves true when it had settled by the time the microtask queue drained.
 */
const hasSettled = async (promise: Promise<void>): Promise<boolean> =>
  // `.then` tags which of the two settles first.
  Promise.race([promise.then(() => true), flushMicrotasks().then(() => false)]);

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
      movingThroughStates(fixture.channel);
      const previous = readerOn(fixture);
      await previous.ready;
      // Not awaited: it never rejects, and the next reader waits for it.
      void previous.close();

      const reader = readerOn(fixture);
      await reader.ready;

      expect(fixture.channel.state).toBe('attached');
      expect(reader.stale).toBe(false);
    });

    it('rejects ready with SessionSubscriptionFailed, and goes stale, when the channel cannot be attached', async () => {
      const fixture = channelWith();
      fixture.channel.attach.mockRejectedValue(new Ably.ErrorInfo('channel failed', 90000, 400));
      const reader = readerOn(fixture);

      await expect(reader.ready).rejects.toBeErrorInfo({
        code: ErrorCode.SessionSubscriptionFailed,
        statusCode: 500,
        message: 'unable to read the channel; channel failed',
        cause: { message: 'channel failed' },
      });
      expect(reader.stale).toBe(true);
    });

    it('keeps the history read’s own error when history cannot be read', async () => {
      const fixture = channelWith();
      fixture.channel.history.mockRejectedValue(new Ably.ErrorInfo('history unavailable', 50000, 500));
      const reader = readerOn(fixture);

      await expect(reader.ready).rejects.toBeErrorInfoWithCode(ErrorCode.SessionHistoryFetchFailed);
      expect(reader.stale).toBe(true);
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

    it('dates a chunk read from history by when it was published, and a live one by when it arrived', async () => {
      const publishedAt = Date.now() - 60_000;
      const wire = wireAcross(first.slice(0, 3), first.slice(3));
      const fixture = channelWith(wire.stored.map((message) => ({ ...message, timestamp: publishedAt })));
      const reader = readerOn(fixture);
      await reader.ready;
      expect(reader.latest?.lastChunkAt).toBe(publishedAt);

      const arrived = Date.now();
      fixture.deliver(wire.live.slice(0, 1));

      expect(reader.latest?.lastChunkAt).toBeGreaterThanOrEqual(arrived);
    });

    it('dates a turn read from history by its newest write, which can be an append to an earlier message', async () => {
      const now = Date.now();
      // The first text part's message was created a minute ago and appended
      // to five seconds ago; the second part started half a minute ago.
      const chunks: AI.UIMessageChunk[] = [
        { type: 'start' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hel' },
        { type: 'text-start', id: 't2' },
      ];
      const stored = wireOf(chunks).stored.map((message, index) => ({
        ...message,
        timestamp: index === 3 ? now - 30_000 : now - 60_000,
        version: index === 2 ? { ...message.version, timestamp: now - 5000 } : message.version,
      }));
      const reader = readerOn(channelWith(stored));
      await reader.ready;

      expect(reader.latest?.lastChunkAt).toBe(now - 5000);
    });

    it('dates a chunk read from history as now when its time is ahead of the local clock', async () => {
      const ahead = Date.now() + 60_000;
      const stored = wireOf(first.slice(0, 3)).stored.map((message) => ({ ...message, timestamp: ahead }));
      const reader = readerOn(channelWith(stored));
      await reader.ready;

      expect(reader.latest?.lastChunkAt).toBeLessThanOrEqual(Date.now());
    });

    it('keeps a turn that ended with an error publishing until the finish the AI SDK writes after it', async () => {
      const failing = failedTurn('t1', 'Hel');
      const wire = wireAcross(failing.slice(0, 4), failing.slice(4));
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const turn = reader.latest;
      expect(turn?.ended).toBe(true);
      expect(turn?.publishing).toBe(true);

      fixture.deliver(wire.live.slice(0, 1));
      expect(turn?.publishing).toBe(true);
      fixture.deliver(wire.live.slice(1));

      expect(turn?.publishing).toBe(false);
      expect(await hasSettled(turn?.settled ?? Promise.resolve())).toBe(true);
    });

    it('marks a turn ended, and resolves whenEnded, when its terminal chunk arrives, even an error', async () => {
      const failing = failedTurn('t1', 'Hel');
      const wire = wireAcross(failing.slice(0, 3), failing.slice(3));
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const turn = reader.latest;
      expect(await hasSettled(turn?.whenEnded ?? Promise.resolve())).toBe(false);

      fixture.deliver(wire.live.slice(0, 1));

      expect(turn?.ended).toBe(true);
      expect(turn?.publishing).toBe(true);
      expect(await hasSettled(turn?.whenEnded ?? Promise.resolve())).toBe(true);
    });

    it('settles a turn when its terminal chunk arrives', async () => {
      const wire = wireAcross(first.slice(0, 3), first.slice(3));
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const turn = reader.latest;
      expect(await hasSettled(turn?.settled ?? Promise.resolve())).toBe(false);

      fixture.deliver(wire.live);

      expect(await hasSettled(turn?.settled ?? Promise.resolve())).toBe(true);
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

    it('keeps waiting for the finish after an error when another chunk comes first', async () => {
      const failing = failedTurn('t1', 'Hel');
      const wire = wireAcross(failing.slice(0, 4), [{ type: 'abort' }, ...failing.slice(4)]);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const turn = reader.latest;

      fixture.deliver(wire.live.slice(0, 1));
      expect(turn?.publishing).toBe(true);
      fixture.deliver(wire.live.slice(1));

      expect(turn?.publishing).toBe(false);
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

    it('settles a turn when the next one starts before it ended', async () => {
      const wire = wireAcross(first.slice(0, 3), second);
      const fixture = channelWith(wire.stored);
      const reader = readerOn(fixture);
      await reader.ready;
      const turn = reader.latest;

      fixture.deliver(wire.live.slice(0, 1));

      expect(turn?.ended).toBe(false);
      expect(await hasSettled(turn?.settled ?? Promise.resolve())).toBe(true);
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

  describe('the channel', () => {
    it('makes the reader stale once the channel loses continuity', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);
      await reader.ready;
      expect(reader.stale).toBe(false);

      fixture.channel.emitStateChange({ current: 'attached', previous: 'attaching', resumed: false });

      expect(reader.stale).toBe(true);
    });

    it('warns when the channel was attached before the reader subscribed, and only then', async () => {
      const warnings: string[] = [];
      const logger = makeLogger({
        logLevel: LogLevel.Warn,
        logHandler: (message: string) => {
          warnings.push(message);
        },
      });
      const attached = channelWith();
      await new TurnReader({ client: attached.client, channel: attached.channel, logger }).ready;
      const detached = channelWith();
      detached.channel.state = 'initialized';
      await new TurnReader({ client: detached.client, channel: detached.channel, logger }).ready;

      expect(warnings).toEqual(['TurnReader; the channel was attached before the reader, so its history starts there']);
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
      expect(fixture.channel.detach).toHaveBeenCalledTimes(1);
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

    it('settles the latest turn', async () => {
      const fixture = channelWith(wireOf(first.slice(0, 3)).stored);
      const reader = readerOn(fixture);
      await reader.ready;

      const turn = reader.latest;
      expect(turn).toBeDefined();

      await reader.close();

      expect(await hasSettled(turn?.settled ?? Promise.resolve())).toBe(true);
    });

    it('rejects ready with OperationCancelled when it closes before history has been read', async () => {
      const fixture = channelWith();
      const reader = readerOn(fixture);

      await reader.close();

      await expect(reader.ready).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    });

    it('rejects ready with OperationCancelled, named AbortError, when it closes during the history replay', async () => {
      const fixture = channelWith();
      const page = Promise.withResolvers<Ably.PaginatedResult<Ably.InboundMessage>>();
      fixture.channel.history.mockReturnValueOnce(page.promise);
      const reader = readerOn(fixture);
      await nextMacrotask();
      expect(fixture.channel.history).toHaveBeenCalledTimes(1);

      const closing = reader.close();
      page.resolve(makePaginated([]));

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
