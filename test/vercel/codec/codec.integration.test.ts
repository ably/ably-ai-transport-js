import { anthropic } from '@ai-sdk/anthropic';
import type * as AI from 'ai';
import { streamText } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { createEncoderCore } from '../../../src/core/codec/index.js';
import { createClientSession } from '../../../src/core/session/index.js';
import type { ClientView } from '../../../src/core/view/index.js';
import { Headers } from '../../../src/headers.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

/**
 * Wait for the subscriber's view to contain a message whose id matches the
 * predicate. Resolves immediately when the predicate is already satisfied.
 * @param view The view to observe.
 * @param matches Predicate run on every change.
 * @param timeoutMs Max wait in ms.
 * @returns A promise resolving when a matching message lands; rejects on timeout.
 */
const waitForMessage = async (
  view: ClientView<typeof UIMessageCodec>,
  matches: (message: AI.UIMessage) => boolean,
  timeoutMs = 10_000,
): Promise<AI.UIMessage> =>
  new Promise<AI.UIMessage>((resolve, reject) => {
    const find = (): AI.UIMessage | undefined => view.messages.find((node) => matches(node.message))?.message;
    const initial = find();
    if (initial) {
      resolve(initial);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out — view.messages.length=${String(view.messages.length)}`));
    }, timeoutMs);
    const unsubscribe = view.subscribe(() => {
      const found = find();
      if (found) {
        clearTimeout(timer);
        unsubscribe();
        resolve(found);
      }
    });
  });

afterEach(() => {
  closeAllClients();
});

describe('UIMessageCodec (integration)', () => {
  it('view.send round-trips a UIMessage from A to B with text and caller-supplied id', async () => {
    const channelName = uniqueChannelName('vercel-codec-discrete');

    // B subscribes first — without history hydration, late subscribers miss
    // earlier publishes.
    const subscriberClient = ablyRealtimeClient();
    const subscriberSession = createClientSession({
      client: subscriberClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await subscriberSession.connect();
    const subscriberView = subscriberSession.createView();

    const publisherClient = ablyRealtimeClient();
    const publisherSession = createClientSession({
      client: publisherClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await publisherSession.connect();
    const publisherView = publisherSession.createView();

    const userMessage: AI.UIMessage = {
      id: 'user-msg-X',
      role: 'user',
      parts: [{ type: 'text', text: 'hello world' }],
    };
    await publisherView.send(userMessage);

    const observed = await waitForMessage(subscriberView, (m) => m.id === 'user-msg-X');

    expect(observed.id).toBe('user-msg-X');
    expect(observed.role).toBe('user');
    expect(observed.parts).toEqual([{ type: 'text', text: 'hello world' }]);

    await subscriberSession.close();
    await publisherSession.close();
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    'pipes a real streamText() response through the codec onto Ably and the subscriber assembles the assistant UIMessage',
    async () => {
      const channelName = uniqueChannelName('vercel-codec-stream-text');

      // B subscribes first — without history hydration, late subscribers
      // miss earlier publishes.
      const subscriberClient = ablyRealtimeClient();
      const subscriberSession = createClientSession({
        client: subscriberClient,
        sessionName: channelName,
        codec: UIMessageCodec,
      });
      await subscriberSession.connect();
      const subscriberView = subscriberSession.createView();

      // Publisher drives the codec encoder directly against its real
      // channel — this is the streaming-side analogue of `view.send`,
      // mirroring how `step.pipe` will look in a later phase.
      const publisherClient = ablyRealtimeClient();
      const channel = publisherClient.channels.get(channelName);
      await channel.attach();

      const core = createEncoderCore(channel);
      const encoder = UIMessageCodec.createEncoder({ core });
      const sdkHeaders = {
        [Headers.MessageId]: 'agent-msg-1',
        [Headers.Role]: 'assistant',
        [Headers.RunId]: 'r-stream-text',
      };

      // Real Anthropic streamText() call — uses the cheap/fast Haiku model
      // with a tightly bounded prompt to keep the integration test
      // deterministic enough to assert on.
      const result = streamText({
        model: anthropic('claude-haiku-4-5'),
        prompt: 'Respond with exactly the lowercase word "hello" and nothing else.',
      });
      const chunkStream = result.toUIMessageStream();
      for await (const chunk of chunkStream) {
        await encoder.encodePart(chunk, { headers: sdkHeaders });
      }
      await encoder.close();

      const observed = await waitForMessage(
        subscriberView,
        (m) => m.id === 'agent-msg-1' && m.parts.some((p) => p.type === 'text' && p.text.length > 0),
        20_000,
      );

      // The response text is whatever Anthropic produced — assert on the
      // shape rather than exact content. The codec drops every non-text
      // chunk (start / start-step / finish / etc.), so the assembled
      // message should have exactly one text part with non-empty content.
      expect(observed.id).toBe('agent-msg-1');
      const textParts = observed.parts.filter((p) => p.type === 'text');
      expect(textParts).toHaveLength(1);
      const firstPart = textParts[0];
      if (firstPart?.type !== 'text') throw new Error('expected text part');
      expect(firstPart.text.length).toBeGreaterThan(0);

      await subscriberSession.close();
    },
    60_000,
  );
});
