/**
 * Custom Codec — Live Ably Roundtrip
 *
 * Runs the custom AgentCodec over a real Ably channel to demonstrate the
 * full encode → publish → subscribe → decode → accumulate pipeline.
 *
 * Two Ably clients participate:
 *   Publisher  — encodes domain events (text deltas, tool calls) into
 *                Ably messages via the encoder
 *   Subscriber — receives Ably messages, decodes them back into domain
 *                events, and accumulates them into a structured AgentMessage
 *
 * Requires ABLY_API_KEY and ABLY_NAMESPACE environment variables. The Ably
 * app must have the namespace configured with message appends enabled.
 *
 * Run with:
 *   ABLY_API_KEY=your-key ABLY_NAMESPACE=mutable npx tsx examples/custom-codec/simulate.ts
 */

import * as Ably from 'ably';

import { HEADER_MSG_ID } from '../../src/constants.js';
import type { DecoderOutput } from '../../src/index.js';
import { AgentCodec } from './codec.js';
import type { AgentEvent, AgentMessage } from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ABLY_API_KEY = process.env.ABLY_API_KEY;
const ABLY_NAMESPACE = process.env.ABLY_NAMESPACE ?? 'mutable';

if (!ABLY_API_KEY) {
  throw new Error(
    'ABLY_API_KEY is required.\n' +
      'Run with: ABLY_API_KEY=your-key ABLY_NAMESPACE=mutable npx tsx examples/custom-codec/simulate.ts',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ANSI colour codes for terminal output.
const cyan = (s: string): string => `\u001B[36m${s}\u001B[0m`;
const green = (s: string): string => `\u001B[32m${s}\u001B[0m`;
const yellow = (s: string): string => `\u001B[33m${s}\u001B[0m`;
const dim = (s: string): string => `\u001B[2m${s}\u001B[0m`;

/**
 * Log an outbound (published) event to the console.
 * @param event - The agent event being encoded and published.
 */
const logPublish = (event: AgentEvent): void => {
  const label = event.type === 'text-delta' ? `text-delta ("${event.delta}")` : event.type;
  console.log(`  ${cyan('→')} ${cyan(label)}`);
};

/**
 * Log an inbound (received and decoded) event to the console.
 * @param event - The decoded agent event received by the subscriber.
 */
const logReceive = (event: AgentEvent): void => {
  if (event.type === 'text-delta' && event.delta) {
    console.log(`  ${green('←')} ${green(`text-delta`)} ${dim(`("${event.delta}")`)}`);
  } else if (event.type === 'tool-call') {
    console.log(`  ${green('←')} ${green('tool-call')} ${dim(`→ ${event.toolName}(${JSON.stringify(event.args)})`)}`);
  } else {
    console.log(`  ${green('←')} ${green(event.type)}`);
  }
};

/**
 * Create an onMessage hook that stamps x-ably-msg-id on every outgoing message.
 *
 * The decoder core reads this header to tag each decoded event with a messageId.
 * The accumulator then uses that messageId to group events that belong to the
 * same response. Without this, the accumulator wouldn't know which events go
 * together.
 *
 * In a real app, the transport stamps this automatically. Here we do it
 * manually since we're using the codec directly without the transport layer.
 * @param messageId - The message ID to stamp.
 * @returns An onMessage hook for encoder options.
 */
const stampMessageId = (messageId: string) => (msg: Ably.Message) => {
  // CAST: Ably SDK types `extras` as `any`; the encoder always sets it.
  const headers = (msg.extras as { headers?: Record<string, string> } | undefined)?.headers;
  if (headers) {
    headers[HEADER_MSG_ID] = messageId;
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Run the live Ably roundtrip simulation. */
const main = async (): Promise<void> => {
  console.log('=== Custom Codec — Live Ably Roundtrip ===\n');

  // Channel name must be in a namespace with message appends enabled.
  // The namespace is the prefix before the colon (e.g. "ai:" or "mutable:").
  const channelName = `${ABLY_NAMESPACE}:custom-codec-example-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`  Channel: ${channelName}\n`);

  // Two clients simulate the server (publisher) and client (subscriber).
  // In a real app these would be separate processes.
  const pubClient = new Ably.Realtime({ key: ABLY_API_KEY, clientId: 'publisher' });
  const subClient = new Ably.Realtime({ key: ABLY_API_KEY, clientId: 'subscriber' });

  try {
    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    // ------------------------------------------------------------------
    // Subscriber side: decoder + accumulator
    // ------------------------------------------------------------------
    // This is what runs on the client. Each Ably message is decoded into
    // domain events, which are fed to the accumulator to build up the
    // structured AgentMessage.

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    let resolveFinish: () => void;
    let rejectFinish: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinish = resolve;
      rejectFinish = reject;
    });

    const timeout = setTimeout(() => {
      rejectFinish(new Error('timed out waiting for finish event (15s)'));
    }, 15_000);

    console.log(`--- ${green('SUBSCRIBE')}: Waiting for events ---\n`);

    // channel.subscribe() delivers all message actions — creates, appends,
    // updates, and deletes. The decoder core dispatches on the action type
    // internally, so you just pass every message through.
    await subChannel.subscribe((msg) => {
      const outputs: DecoderOutput<AgentEvent, AgentMessage>[] = decoder.decode(msg);
      accumulator.processOutputs(outputs);

      for (const output of outputs) {
        if (output.kind === 'event') {
          logReceive(output.event);
          if (output.event.type === 'finish') {
            clearTimeout(timeout);
            resolveFinish();
          }
        }
      }
    });

    // ------------------------------------------------------------------
    // Publisher side: encoder
    // ------------------------------------------------------------------
    // This is what runs on the server. Domain events from the model are
    // encoded into Ably messages via the encoder.

    const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;

    // Pass the Ably channel directly as the ChannelWriter — RealtimeChannel
    // satisfies the interface (publish, appendMessage, updateMessage).
    //
    // The onMessage hook here stamps x-ably-msg-id for accumulator
    // correlation. This is a transport-level concern — when you use the
    // codec with createServerTransport/createClientTransport, the transport
    // stamps this header automatically. You only need the onMessage hook
    // when using the codec directly without the transport layer, as we do
    // in this example.
    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampMessageId(messageId),
    });

    console.log(`--- ${cyan('PUBLISH')}: Encoding domain events ---\n`);

    // These events simulate what a model would produce. In a real app,
    // you'd pipe these from your model's streaming response.
    const events: AgentEvent[] = [
      { type: 'start' },
      { type: 'text-delta', delta: 'Let me ' },
      { type: 'text-delta', delta: 'check the ' },
      { type: 'text-delta', delta: 'weather for you.' },
      { type: 'text-end' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'get_weather',
        args: { city: 'London', units: 'celsius' },
      },
      { type: 'finish' },
    ];

    for (const event of events) {
      await encoder.appendEvent(event);
      logPublish(event);
    }
    // Always close the encoder when done — this flushes pending appends
    // and runs recovery for any that failed.
    await encoder.close();

    console.log('\n  Waiting for subscriber to receive all events...\n');

    await finished;

    // ------------------------------------------------------------------
    // Result: the accumulated message
    // ------------------------------------------------------------------

    console.log(`--- ${yellow('RESULT')}: Assembled AgentMessage ---\n`);

    for (const msg of accumulator.messages) {
      console.log(`  Message ID: ${msg.id}`);
      console.log(`  Role:       ${msg.role}`);
      console.log(`  Text:       "${msg.text}"`);
      console.log(`  Tool Calls: ${String(msg.toolCalls.length)}`);
      for (const tc of msg.toolCalls) {
        console.log(`    - ${tc.toolName}(${JSON.stringify(tc.args)})`);
      }
    }

    console.log('\n  Text was streamed via message appends.');
    console.log('  Tool calls arrived as discrete messages.');
    console.log('  Both assembled into a single structured AgentMessage.\n');
  } finally {
    pubClient.close();
    subClient.close();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
