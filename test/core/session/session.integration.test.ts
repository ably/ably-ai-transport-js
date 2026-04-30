import { afterEach, describe, expect, it } from 'vitest';

import { createClientSession } from '../../../src/core/session/index.js';
import type { ClientView } from '../../../src/core/view/index.js';
import { Headers } from '../../../src/headers.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

/**
 * Wait until the view's messages reach the expected count, polling via the
 * view's own subscribe. Resolves immediately if the count is already met.
 * @param view The view to observe.
 * @param expected Target message count.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves when the target count is met or rejects on timeout.
 */
const waitForMessages = async (view: ClientView<StubCodec>, expected: number, timeoutMs = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (view.messages.length >= expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out — view.messages.length=${String(view.messages.length)}`));
    }, timeoutMs);
    const unsubscribe = view.subscribe(() => {
      if (view.messages.length >= expected) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });

afterEach(() => {
  closeAllClients();
});

/**
 * Phase 2 end-to-end milestone: B subscribes via a `ClientSession`, then A
 * publishes a hand-crafted `Ably.Message` carrying the SDK headers; B's view
 * `subscribe` fires and `view.messages` contains the decoded node.
 *
 * Using two real Realtime clients on the sandbox proves the wire path —
 * channel attach, header propagation through `extras.headers`, decode loop,
 * tree application, view notification.
 *
 * Without phase 13's history hydration, B must subscribe before A publishes
 * — late subscribers miss earlier publishes.
 */
describe('Session decode loop (integration)', () => {
  it('B receives an inbound published by A and the view fires once', async () => {
    const channelName = uniqueChannelName('session-decode');

    const subscriberClient = ablyRealtimeClient();
    const session = createClientSession({
      client: subscriberClient,
      sessionName: channelName,
      codec: stubCodec,
    });

    await session.connect();
    const view = session.createView();

    let notifications = 0;
    view.subscribe(() => {
      notifications++;
    });

    const publisherClient = ablyRealtimeClient();
    const publisherChannel = publisherClient.channels.get(channelName);

    await publisherChannel.publish({
      name: 'x-ably-message',
      data: 'hello-from-a',
      extras: {
        headers: {
          [Headers.MessageId]: 'm-1',
          [Headers.Role]: 'user',
        },
      },
    });

    await waitForMessages(view, 1);

    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.id).toBe('m-1');
    expect(view.messages[0]?.role).toBe('user');
    expect(view.messages[0]?.message).toBe('hello-from-a');
    // The publisher's connection clientId attributes the message when no
    // explicit x-ably-client-id is set.
    expect(view.messages[0]?.clientId).toBe(publisherClient.auth.clientId);
    expect(notifications).toBeGreaterThanOrEqual(1);

    await session.close();
  });

  it('honours x-ably-client-id when the publisher sets it explicitly', async () => {
    const channelName = uniqueChannelName('session-decode-clientid');

    const subscriberClient = ablyRealtimeClient();
    const session = createClientSession({
      client: subscriberClient,
      sessionName: channelName,
      codec: stubCodec,
    });

    await session.connect();
    const view = session.createView();

    const publisherClient = ablyRealtimeClient();
    const publisherChannel = publisherClient.channels.get(channelName);

    await publisherChannel.publish({
      name: 'x-ably-message',
      data: 'hello-from-end-user',
      extras: {
        headers: {
          [Headers.MessageId]: 'm-1',
          [Headers.Role]: 'user',
          [Headers.ClientId]: 'end-user-1',
        },
      },
    });

    await waitForMessages(view, 1);

    expect(view.messages[0]?.clientId).toBe('end-user-1');

    await session.close();
  });
});
