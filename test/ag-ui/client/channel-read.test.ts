import * as Ably from '@ably/pubsub-core';
import type * as AGUI from '@ag-ui/client';
import { describe, expect, it } from 'vitest';

import { ChannelRead } from '../../../src/ag-ui/client/channel-read.js';
import { ErrorCode } from '../../../src/errors.js';
import { silentLogger } from '../../helper/logger.js';
import { type ChannelFixture, channelWith, gate } from '../../helper/read-channel.js';
import { nextMacrotask } from '../../helper/streams.js';
import { foreignMessage, textRun, wireOf } from './fixtures.js';

/** What a read's handlers were given, and in what order. */
interface Recorded {
  /** Each handler call, in order, by the handler's name, and for `onEvent` the event's type. */
  calls: string[];
  /** The events `onEvent` was given. */
  events: AGUI.Event[];
  /** The errors `onUndecodable` was given. */
  undecodable: Ably.ErrorInfo[];
  /** What each `onEnd` call was given. */
  ends: (Ably.ErrorInfo | undefined)[];
}

/**
 * A read of the fixture's channel whose handlers record what they are given.
 * @param fixture - The channel to read.
 * @returns The read and what its handlers recorded.
 */
const readOn = (fixture: ChannelFixture): { read: ChannelRead; recorded: Recorded } => {
  const recorded: Recorded = { calls: [], events: [], undecodable: [], ends: [] };
  const read = new ChannelRead({
    channel: fixture.channel,
    logger: silentLogger,
    onAttached: () => {
      recorded.calls.push('onAttached');
    },
    onEvent: (event) => {
      recorded.calls.push(`onEvent ${event.type}`);
      recorded.events.push(event);
    },
    onUndecodable: (error) => {
      recorded.undecodable.push(error);
    },
    onEnd: (error) => {
      recorded.calls.push('onEnd');
      recorded.ends.push(error);
    },
  });
  return { read, recorded };
};

/**
 * A copy of a message whose data the AG-UI codec cannot decode.
 * @param message - The message.
 * @returns The broken copy.
 */
const undecodable = (message: Ably.InboundMessage | undefined): Ably.InboundMessage => {
  if (message === undefined) throw new Error('no message to break');
  return { ...message, data: 'not an event' };
};

const run = textRun('r1', 'm1', ['Hi']);

describe('ChannelRead', () => {
  it('subscribes and attaches the channel, then calls onAttached', async () => {
    const fixture = channelWith();
    const { recorded } = readOn(fixture);
    await nextMacrotask();

    const [subscribed] = fixture.channel.subscribe.mock.invocationCallOrder;
    const [attached] = fixture.channel.attach.mock.invocationCallOrder;
    expect(subscribed).toBeLessThan(attached ?? 0);
    expect(fixture.channel.state).toBe('attached');
    expect(recorded.calls).toEqual(['onAttached']);
    expect(fixture.channel.history).not.toHaveBeenCalled();
  });

  it('hands on each event in order, leaving out messages no codec wrote', async () => {
    const fixture = channelWith();
    const { recorded } = readOn(fixture);
    await nextMacrotask();

    fixture.deliver([foreignMessage('s9999'), ...wireOf(run).live]);

    expect(recorded.events).toEqual(run);
  });

  it('waits for a detach in flight to finish before it subscribes, as when the application lets the channel go', async () => {
    const fixture = channelWith();
    fixture.channel.state = 'detaching';
    const { recorded } = readOn(fixture);
    await nextMacrotask();
    expect(fixture.channel.subscribe).not.toHaveBeenCalled();

    fixture.channel.state = 'detached';
    fixture.channel.emitStateChange({ current: 'detached', previous: 'detaching', resumed: false });
    await nextMacrotask();

    expect(recorded.calls).toEqual(['onAttached']);
    expect(fixture.channel.state).toBe('attached');
  });

  describe('when it is released', () => {
    it('unsubscribes, stops handing on messages, and leaves the channel attached', async () => {
      const fixture = channelWith();
      const { read, recorded } = readOn(fixture);
      await nextMacrotask();
      const { live } = wireOf(run);
      fixture.deliver(live.slice(0, 2));
      const listener = fixture.channel.listener;

      read.release();
      if (listener !== undefined) for (const message of live.slice(2)) listener(message);

      expect(recorded.events).toEqual(run.slice(0, 2));
      expect(fixture.channel.unsubscribe).toHaveBeenCalledWith(listener);
      expect(fixture.channel.detach).not.toHaveBeenCalled();
      expect(fixture.channel.state).toBe('attached');
    });

    it('never subscribes when released while it waits for a detach in flight', async () => {
      const fixture = channelWith();
      fixture.channel.state = 'detaching';
      const { read, recorded } = readOn(fixture);
      await nextMacrotask();

      read.release();
      fixture.channel.state = 'detached';
      fixture.channel.emitStateChange({ current: 'detached', previous: 'detaching', resumed: false });
      await nextMacrotask();

      expect(fixture.channel.subscribe).not.toHaveBeenCalled();
      expect(recorded.calls).toEqual([]);
    });

    it('leaves the channel unattached when released during its subscribe', async () => {
      const fixture = channelWith();
      const subscribing = gate();
      fixture.channel.subscribe.mockImplementationOnce(async (listener) => {
        fixture.channel.listener = listener;
        await subscribing.promise;
        // eslint-disable-next-line unicorn/no-null -- ably-js resolves subscribe with null when the attach changed nothing
        return null;
      });
      const { read, recorded } = readOn(fixture);
      await nextMacrotask();

      read.release();
      subscribing.open();
      await nextMacrotask();

      expect(fixture.channel.attach).not.toHaveBeenCalled();
      expect(recorded.calls).toEqual([]);
    });

    it('releases once', async () => {
      const fixture = channelWith();
      const { read } = readOn(fixture);
      await nextMacrotask();

      read.release();
      read.release();

      expect(fixture.channel.unsubscribe).toHaveBeenCalledTimes(1);
      expect(fixture.channel.off).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the channel fails', () => {
    it.each([
      ['FAILED', 'failed'],
      ['SUSPENDED', 'suspended'],
    ] as const)(
      'ends with SessionContinuityNotGuaranteed, carrying the reason, when the channel becomes %s after it attached',
      async (_name, current) => {
        const fixture = channelWith();
        const { recorded } = readOn(fixture);
        await nextMacrotask();
        const reason = new Ably.ErrorInfo('connection suspended', 80002, 400);

        fixture.channel.emitStateChange({ current, previous: 'attached', resumed: false, reason });

        expect(recorded.ends).toEqual([
          expect.toBeErrorInfo({
            code: ErrorCode.SessionContinuityNotGuaranteed,
            statusCode: 500,
            cause: { code: 80002 },
          }),
        ]);
      },
    );

    it('ends with SessionContinuityNotGuaranteed when the channel attaches again without resuming', async () => {
      const fixture = channelWith();
      const { recorded } = readOn(fixture);
      await nextMacrotask();

      fixture.channel.emitStateChange({ current: 'attached', previous: 'attached', resumed: false });

      expect(recorded.ends).toEqual([
        expect.toBeErrorInfo({
          message:
            'unable to read the channel; the channel attached again without resuming, so the run may be missing events',
          code: ErrorCode.SessionContinuityNotGuaranteed,
        }),
      ]);
    });

    it('reads on when the channel attaches again and resumes', async () => {
      const fixture = channelWith();
      const { recorded } = readOn(fixture);
      await nextMacrotask();

      fixture.channel.emitStateChange({ current: 'attached', previous: 'attached', resumed: true });

      expect(recorded.ends).toEqual([]);
    });

    it('ends with no error when the channel becomes DETACHED, as when the page closes its client', async () => {
      const fixture = channelWith();
      const { recorded } = readOn(fixture);
      await nextMacrotask();

      fixture.channel.emitStateChange({ current: 'detached', previous: 'attached', resumed: false });
      fixture.channel.emitStateChange({ current: 'failed', previous: 'detached', resumed: false });

      expect(recorded.ends).toEqual([undefined]);
    });

    it('takes the state changes before its first attach as the channel coming up', async () => {
      const fixture = channelWith();
      fixture.channel.state = 'detached';
      const subscribing = gate();
      fixture.channel.subscribe.mockImplementationOnce(async (listener) => {
        fixture.channel.listener = listener;
        await subscribing.promise;
        // eslint-disable-next-line unicorn/no-null -- ably-js resolves subscribe with null when the attach changed nothing
        return null;
      });
      const { recorded } = readOn(fixture);
      await nextMacrotask();

      fixture.channel.emitStateChange({ current: 'attaching', previous: 'detached', resumed: false });
      fixture.channel.emitStateChange({ current: 'suspended', previous: 'attaching', resumed: false });
      subscribing.open();
      await nextMacrotask();

      expect(recorded.calls).toEqual(['onAttached']);
    });

    it('ends with the attach failure’s own code when the channel refuses the attach', async () => {
      const fixture = channelWith();
      fixture.channel.attach.mockRejectedValueOnce(new Ably.ErrorInfo('channel denied access', 40160, 401));
      const { recorded } = readOn(fixture);
      await nextMacrotask();

      expect(recorded.calls).toEqual(['onEnd']);
      expect(recorded.ends).toEqual([
        expect.toBeErrorInfo({
          message: 'unable to read the channel; channel denied access',
          code: 40160,
          statusCode: 401,
          cause: { code: 40160 },
        }),
      ]);
    });

    it('ends with the refusal ably-js gives a subscribe on a FAILED channel, which it leaves to the application', async () => {
      const fixture = channelWith();
      fixture.channel.state = 'failed';
      // ably-js refuses to subscribe on a FAILED channel.
      fixture.channel.subscribe.mockRejectedValueOnce(new Ably.ErrorInfo('channel state is failed', 90001, 400));
      const { recorded } = readOn(fixture);
      await nextMacrotask();

      expect(recorded.ends).toEqual([expect.toBeErrorInfo({ code: 90001, statusCode: 400, cause: { code: 90001 } })]);
      expect(fixture.channel.attach).not.toHaveBeenCalled();
    });
  });

  it('reports a message it cannot decode, and hands on no event for it', async () => {
    const fixture = channelWith();
    const { recorded } = readOn(fixture);
    await nextMacrotask();

    fixture.deliver([undecodable(wireOf(run).live[0])]);

    expect(recorded.undecodable).toEqual([expect.toBeErrorInfo({ code: ErrorCode.SessionMessageProcessingFailed })]);
    expect(recorded.events).toEqual([]);
  });
});
