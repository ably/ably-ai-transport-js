/**
 * OpenAI ResponsesCodec integration test.
 *
 * Validates the encode -> publish -> subscribe -> decode -> fold roundtrip for
 * streamed assistant text over a real Ably channel (sandbox by default). Proves
 * the wire format and Ably message append semantics work end-to-end for the
 * text increment, without transport machinery.
 */

import type { Responses } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it } from 'vitest';

import { toCodecEvents } from '../../../src/core/codec/codec-event.js';
import { ResponsesCodec } from '../../../src/openai/codec/index.js';
import { init, type OpenAIProjection } from '../../../src/openai/codec/reducer.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import {
  completed,
  contentPartAdded,
  created,
  firstInputText,
  itemAdded,
  messageItem,
  metaOf,
  stampHeaders,
  textDelta,
  textDone,
  userTurn,
} from './fixtures.js';

describe('OpenAI ResponsesCodec integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('text response roundtrip', async () => {
    const channelName = uniqueChannelName('openai-text-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    const messageId = 'msg-1';
    const itemId = 'item-1';

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      if (decoded.outputs.some((e) => e.type === 'response.completed')) resolveDone();
    });

    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', messageId) });

    await encoder.publishOutput(created());
    await encoder.publishOutput(itemAdded(messageItem(itemId)));
    await encoder.publishOutput(contentPartAdded(itemId));
    // Fire-and-forget deltas: the encoder accumulates them internally and
    // flushes on close, so they need not block the publish sequence.
    void encoder.publishOutput(textDelta(itemId, 'Hello, '));
    void encoder.publishOutput(textDelta(itemId, 'world!'));
    await encoder.publishOutput(textDone(itemId, 'Hello, world!'));
    await encoder.publishOutput(completed());
    await encoder.close();

    await done;

    const messages = ResponsesCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.role).toBe('assistant');
    const message = messages[0]?.message.items.find((i): i is Responses.ResponseOutputMessage => i.type === 'message');
    const part = message?.content.find((p) => p.type === 'output_text');
    expect(part?.type === 'output_text' ? part.text : '').toBe('Hello, world!');
  });

  it('user message roundtrip', async () => {
    const channelName = uniqueChannelName('openai-user-roundtrip');
    const pubChannel = ablyRealtimeClient().channels.get(channelName);
    const subChannel = ablyRealtimeClient().channels.get(channelName);

    const decoder = ResponsesCodec.createDecoder();
    let projection: OpenAIProjection = init();

    let resolveDone: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      for (const event of toCodecEvents(decoded)) projection = ResponsesCodec.fold(projection, event, metaOf(msg));
      if (decoded.inputs.length > 0) resolveDone();
    });

    const encoder = ResponsesCodec.createEncoder(pubChannel, { onMessage: stampHeaders('run-1', 'u-1') });
    await encoder.publishInput(ResponsesCodec.createUserMessage(userTurn('what is the weather in London?')));
    await encoder.close();

    await done;

    const messages = ResponsesCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.role).toBe('user');
    expect(firstInputText(messages[0]?.message)).toBe('what is the weather in London?');
  });
});
