/**
 * The codec-to-transport seam, composed from real parts.
 *
 * Every other transport test drives a codec double, and every codec test drives
 * its own encoder and decoder directly. Neither covers the join: the transport
 * owns `extras.ai.transport` while the codec owns `extras.ai.codec` and the
 * payload, and each half has to leave the other's bucket alone. These tests
 * wire a real `AgentTransport` and a real `ClientTransport` to the real Vercel
 * wire codec, relay one's publishes into the other's listener, and assert the
 * client decodes what the agent published.
 *
 * The relay carries only `message.create` deliveries, so the agent publishes
 * discrete outputs rather than piping a stream. Append accumulation is the
 * decoder's own contract and is pinned in `test/vercel/codec/decoder.test.ts`;
 * what is under test here is the header split and the run-id correlation
 * neither side can verify alone.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { HEADER_INPUT_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import { createAgentTransport } from '../../../src/core/transport/agent-transport.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { TransportEvent } from '../../../src/core/transport/types/transport.js';
import { getTransportHeaders } from '../../../src/utils.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { flushMicrotasks } from '../../helper/streams.js';

type Event = TransportEvent<VercelInput, VercelOutput>;

/**
 * Turn a message the encoder published into the inbound delivery a subscriber
 * would receive, assigning the serial the mock channel acknowledged.
 * @param msg - The published message.
 * @param serial - The serial to deliver it under.
 * @param clientId - The publisher's clientId.
 * @returns The inbound wire message.
 */
const asDelivery = (msg: Ably.Message, serial: string, clientId: string): Ably.InboundMessage =>
  // CAST: `Ably.Message.data` and `.extras` are typed `any` by the SDK, and the
  // literal is a minimal InboundMessage — the receive tier reads only these
  // fields. Both halves are the SDK's own looseness, not a narrowing we make.
  ({
    name: msg.name,
    data: msg.data as unknown,
    extras: msg.extras as unknown,
    action: 'message.create',
    clientId,
    serial,
    timestamp: 1,
    version: { serial: `${serial}-v0`, timestamp: 1 },
  }) as unknown as Ably.InboundMessage;

/**
 * Relay every message published on `from` into `into`'s subscribed listener,
 * oldest first.
 * @param from - The channel whose publishes to drain.
 * @param into - The channel whose listener receives them.
 * @param clientId - The publisher's clientId to stamp on each delivery.
 */
const relay = (from: MockChannel, into: MockChannel, clientId: string): void => {
  for (const [i, msg] of from.publishCalls.entries()) {
    into.listener?.(asDelivery(msg, `serial-${String(i + 1)}`, clientId));
  }
};

/**
 * Stand up a connected agent + client pair over the real Vercel codec, each on
 * its own mock channel (the relay carries publishes across).
 * @returns The connected transports and their channels.
 */
const connectedPair = async (): Promise<{
  agent: ReturnType<typeof createAgentTransport<VercelInput, VercelOutput>>;
  client: ReturnType<typeof createClientTransport<VercelInput, VercelOutput>>;
  agentChannel: MockChannel & Ably.RealtimeChannel;
  clientChannel: MockChannel & Ably.RealtimeChannel;
}> => {
  const agentChannel = createMockChannel();
  const clientChannel = createMockChannel();
  const agent = createAgentTransport<VercelInput, VercelOutput>({
    channel: agentChannel,
    codec: createUIMessageCodec(),
    clientId: 'agent-1',
  });
  const client = createClientTransport<VercelInput, VercelOutput>({
    channel: clientChannel,
    codec: createUIMessageCodec(),
    clientId: 'user-1',
  });
  await agent.connect();
  await client.connect();
  return { agent, client, agentChannel, clientChannel };
};

describe('codec and transport composed', () => {
  it('carries an agent output through the real codec onto the client event stream', async () => {
    const { agent, client, agentChannel, clientChannel } = await connectedPair();

    const seen: Event[] = [];
    client.subscribe((event) => seen.push(event));

    // No `runId` pin: without a located input, pinning one means "continue
    // this run" and publishes `ai-run-resume` instead of `ai-run-start`.
    const run = agent.openRun();
    const step = run.createStep({ stepId: 'step-1' });
    await step.send({ type: 'start', messageId: 'asst-1' });
    await step.send({ type: 'tool-output-available', toolCallId: 'tc-1', output: { tempC: 4 } });
    await step.send({ type: 'finish' });
    await step.end({ reason: 'complete' });
    await run.end({ reason: 'complete' });
    await flushMicrotasks();

    relay(agentChannel, clientChannel, 'agent-1');

    // The chunks arrive as the agent published them, through a codec the client
    // built independently — nothing in either transport reads the payload.
    const outputs = seen.flatMap((e) => (e.kind === 'message' ? e.outputs : []));
    expect(outputs).toEqual([
      { type: 'start', messageId: 'asst-1' },
      { type: 'tool-output-available', toolCallId: 'tc-1', output: { tempC: 4 } },
      // The codec defaults `finishReason` on decode; the transport never reads it.
      { type: 'finish', finishReason: 'stop' },
    ]);

    // The run brackets classify as lifecycle, not as messages.
    const lifecycle = seen.flatMap((e) => (e.kind === 'run-lifecycle' ? [e.event.type] : []));
    expect(lifecycle).toEqual(['start', 'end']);
  });

  it('keeps the transport and codec header tiers separate on the wire', async () => {
    const agentChannel = createMockChannel();
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: agentChannel,
      codec: createUIMessageCodec(),
      clientId: 'agent-1',
    });
    await agent.connect();

    const run = agent.openRun();
    const step = run.createStep({ stepId: 'step-1' });
    await step.send({ type: 'start', messageId: 'asst-9' });
    await flushMicrotasks();

    const output = agentChannel.publishCalls.at(-1);
    if (!output) throw new Error('no output published');

    // The transport wrote its own tier and nothing else. The codec's tier is
    // present and non-empty, and the run-id is NOT in it.
    // CAST: `extras` is `any` on Ably.Message; the shape is asserted below.
    const extras = output.extras as { ai?: { transport?: Record<string, string>; codec?: Record<string, string> } };
    // CAST: getTransportHeaders reads only `extras`, which the published message carries.
    expect(getTransportHeaders(output as unknown as Ably.InboundMessage)[HEADER_RUN_ID]).toBe(run.runId);
    expect(extras.ai?.codec).toBeDefined();
    expect(extras.ai?.codec?.[HEADER_RUN_ID]).toBeUndefined();
  });

  it('resolves the client publish runId from the run the agent opened for it', async () => {
    const { agent, client, agentChannel, clientChannel } = await connectedPair();

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    });

    // The agent sees the input, then opens a fresh run naming it — which is the
    // only thing that lets the client learn its run-id. `runId` is deliberately
    // not pinned: without a located input, pinning it means "continue this run"
    // and publishes `ai-run-resume`, which carries no input correlation.
    relay(clientChannel, agentChannel, 'user-1');
    const run = agent.openRun({ inputCodecMessageId: sent.codecMessageId });
    await flushMicrotasks();
    relay(agentChannel, clientChannel, 'agent-1');

    await expect(sent.runId).resolves.toBe(run.runId);

    // The correlation rides the header the client matches on, not the body.
    const start = agentChannel.publishCalls.find((m) => m.name === 'ai-run-start');
    if (!start) throw new Error('no run-start published');
    // CAST: getTransportHeaders reads only `extras`, which the published message carries.
    expect(getTransportHeaders(start as unknown as Ably.InboundMessage)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe(
      sent.codecMessageId,
    );
  });
});
