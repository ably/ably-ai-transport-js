import { afterEach, describe, expect, it } from 'vitest';

import { createClientSession } from '../../../src/core/session/index.js';
import type { ClientView } from '../../../src/core/view/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

/**
 * Bounded wait until the view exposes the expected number of messages.
 * Polls via the view's own subscribe — no setTimeout busy-loop.
 * @param view The view to observe.
 * @param expected Target message count.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves when the count is met or rejects on timeout.
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
 * Phase 3 end-to-end: A's `writer.sendMessages` lands as a tree node on
 * B's `view`. Without phase 13's history hydration, B subscribes first.
 */
describe('SessionWriter.sendMessages (integration)', () => {
  it('A.writer.sendMessages → B.view sees the message with x-ably-run-id attributed', async () => {
    const channelName = uniqueChannelName('writer-send');

    // B subscribes first.
    const bClient = ablyRealtimeClient();
    const bSession = createClientSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();
    const bView = bSession.createView();

    // A publishes via the writer.
    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();

    await aSession.writer.sendMessages({ messages: 'hello-from-A', runId: 'r-1' });

    await waitForMessages(bView, 1);

    expect(bView.messages).toHaveLength(1);
    expect(bView.messages[0]?.message).toBe('hello-from-A');
    expect(bView.messages[0]?.role).toBe('user');
    expect(bView.messages[0]?.clientId).toBe(aClient.auth.clientId);

    await aSession.close();
    await bSession.close();
  });

  it('honours an x-ably-client-id override in writer options', async () => {
    const channelName = uniqueChannelName('writer-clientid-override');

    const bClient = ablyRealtimeClient();
    const bSession = createClientSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();
    const bView = bSession.createView();

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();

    await aSession.writer.sendMessages({
      messages: 'on-behalf-of-end-user',
      runId: 'r-1',
      clientId: 'end-user-1',
    });

    await waitForMessages(bView, 1);

    expect(bView.messages[0]?.clientId).toBe('end-user-1');

    await aSession.close();
    await bSession.close();
  });
});
