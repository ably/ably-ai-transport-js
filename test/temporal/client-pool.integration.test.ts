/**
 * Connection pooling against real Ably.
 *
 * The pool's unit tests model ably-js's behaviour; only a real connection can
 * confirm the model. Two things need proving here, and neither is provable with
 * mocks.
 *
 * First, that reuse actually happens on the happy path. Every gate the pool
 * applies falls back to closing the client, so a wrong reading of ably-js would
 * turn the whole feature into a silent no-op that still passes its unit tests.
 *
 * Second, that a recycled connection serves its next session correctly. Two
 * hazards would show up here and nowhere else. A channel object that survived
 * `channels.release` is dropped from `channels.all`, after which inbound messages
 * for that name are discarded, so the second session would attach and then hear
 * nothing. And `attachSerial` is refreshed only by an ATTACHED message, so a
 * channel reused while still attached would page `untilAttach` history from the
 * first session's attach point and never find the second trigger.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { buildTransportHeaders } from '../../src/core/transport/headers.js';
import { Invocation } from '../../src/core/transport/invocation.js';
import type { AgentSession, RunIdentity } from '../../src/core/transport/types.js';
import { createSessionScope } from '../../src/temporal/session-scope.js';
import type { VercelOutput, VercelProjection } from '../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../helper/realtime-client.js';

const UIMessageCodec = createUIMessageCodec();

type AgentSessionT = AgentSession<VercelOutput, VercelProjection, AI.UIMessage>;

/** Records the clients a scope builds, so reuse is observable. */
interface TrackedFactory {
  createClient: () => Ably.Realtime;
  readonly built: number;
}

/**
 * A client factory that counts how many connections it opened.
 * @returns The factory and its running count.
 */
const trackedFactory = (): TrackedFactory => {
  let built = 0;
  return {
    createClient: (): Ably.Realtime => {
      built += 1;
      return ablyRealtimeClient();
    },
    get built(): number {
      return built;
    },
  };
};

/**
 * Publish a user input on the channel, out of band, the way a browser client
 * does before any agent process attaches.
 * @param channelName - The channel to publish on.
 * @param publisher - The publishing client.
 * @param text - The message text.
 * @param codecMessageId - The codec-level message id.
 * @returns The invocation naming the published input event.
 */
const publishInput = async (
  channelName: string,
  publisher: Ably.Realtime,
  text: string,
  codecMessageId: string,
): Promise<Invocation> => {
  const inputEventId = crypto.randomUUID();
  const channel = publisher.channels.get(channelName);
  const headers = buildTransportHeaders({ role: 'user', codecMessageId, inputEventId });
  const encoder = UIMessageCodec.createEncoder(channel, { extras: { headers } });
  await encoder.publishInput(
    UIMessageCodec.createUserMessage({ id: codecMessageId, role: 'user', parts: [{ type: 'text', text }] }),
  );
  return Invocation.fromJSON({ inputEventId, sessionName: channelName });
};

/**
 * Open a run for a trigger that already sits in channel history, then close it.
 *
 * Paging until the trigger surfaces is the part that matters: it is an
 * `untilAttach` history read, so it is exactly what a stale `attachSerial` on a
 * recycled channel would break.
 * @param session - The connected agent session.
 * @param invocation - The invocation naming the trigger.
 * @returns The opened run's identity.
 */
const openAndEndRun = async (session: AgentSessionT, invocation: Invocation): Promise<RunIdentity> => {
  const run = session.createRun(invocation);

  const state = { located: false };
  const locatedTag = run.located.then(
    () => {
      state.located = true;
    },
    () => {
      state.located = true;
    },
  );
  for (let page = 0; page < 20 && !state.located && run.view.hasOlder(); page++) {
    await Promise.race([run.view.loadOlder(100), locatedTag]);
  }
  await run.located;

  await run.start();
  const identity: RunIdentity = { runId: run.runId, invocationId: run.invocationId };
  await run.end({ reason: 'complete' });
  return identity;
};

describe('client pool over real Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('reuses one connection across sequential activities, and the recycled one still reads history', async () => {
    const factory = trackedFactory();
    const scope = createSessionScope({
      codec: UIMessageCodec,
      createClient: factory.createClient,
      maxIdle: 1,
    });
    const channelName = uniqueChannelName('pool-reuse');
    const publisher = ablyRealtimeClient({ clientId: 'user-pool' });

    // Turn one. The trigger is published before anything attaches, so opening the
    // run has to reach it through history.
    const first = await publishInput(channelName, publisher, 'first turn', 'u-1');
    const firstIds = await scope.inSession(first, async ({ session, invocation }) =>
      openAndEndRun(session, invocation),
    );
    expect(firstIds.runId).toBeTruthy();
    expect(factory.built).toBe(1);

    // Turn two, on the same channel. The trigger again lands while nothing is
    // attached, and this session runs on the connection turn one handed back.
    const second = await publishInput(channelName, publisher, 'second turn', 'u-2');
    const secondIds = await scope.inSession(second, async ({ session, invocation }) =>
      openAndEndRun(session, invocation),
    );

    // The run opened, so the recycled connection attached cleanly and its history
    // read reached a trigger published before it attached.
    expect(secondIds.runId).toBeTruthy();
    expect(secondIds.runId).not.toBe(firstIds.runId);
    // The point of the pool: one WebSocket handshake served both activities.
    expect(factory.built).toBe(1);

    await scope.close();
  }, 30_000);

  it('gives concurrent activities on one channel distinct connections', async () => {
    const factory = trackedFactory();
    const scope = createSessionScope({
      codec: UIMessageCodec,
      createClient: factory.createClient,
    });
    const channelName = uniqueChannelName('pool-concurrent');
    const publisher = ablyRealtimeClient({ clientId: 'user-concurrent' });

    const first = await publishInput(channelName, publisher, 'concurrent one', 'u-c1');
    const second = await publishInput(channelName, publisher, 'concurrent two', 'u-c2');

    // Hold both sessions open at once. Sharing a client here would mean sharing
    // one RealtimeChannel, and the first detach would tear the second down.
    const bothIn = { count: 0 };
    const release: { resolve?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });

    const activity = async (invocation: Invocation): Promise<RunIdentity> =>
      scope.inSession(invocation, async ({ session, invocation: parsed }) => {
        bothIn.count += 1;
        if (bothIn.count === 2) release.resolve?.();
        await gate;
        return openAndEndRun(session, parsed);
      });

    const [firstIds, secondIds] = await Promise.all([activity(first), activity(second)]);

    expect(firstIds.runId).toBeTruthy();
    expect(secondIds.runId).toBeTruthy();
    expect(factory.built).toBe(2);

    await scope.close();
  }, 30_000);
});
