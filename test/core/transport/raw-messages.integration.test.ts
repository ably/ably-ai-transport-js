/**
 * Channel-sharing integration tests (TESTS.md scenario 13).
 *
 * Prove over real Ably that a session channel can carry application-owned
 * Pub/Sub traffic alongside the transport's wire traffic:
 *
 *  - raw messages interleaved with a run leave the transport's conversation
 *    state unaffected
 *  - a cold-started client reads the raw record back with `fetchRawHistory`,
 *    with the default `isForeignMessage` filter classifying real wire
 *    messages correctly
 *  - `mergeBySerial` + `runStartSerialOf` interleave the conversation with
 *    the raw record in publish order
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { createClientSession } from '../../../src/core/transport/client-session.js';
import { fetchRawHistory, mergeBySerial, runStartSerialOf } from '../../../src/core/transport/raw-messages.js';
import type { AgentSession, ClientSession } from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { textResponseStream } from '../../integration/helpers.js';

type ClientSessionT = ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
type AgentSessionT = AgentSession<VercelOutput, VercelProjection, AI.UIMessage>;

const waitForMessages = async (ct: ClientSessionT, expected: number, timeout = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (ct.view.getMessages().length >= expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(
        new Error(`timed out waiting for ${String(expected)} messages (got ${String(ct.view.getMessages().length)})`),
      );
    }, timeout);
    const unsub = ct.view.on('update', () => {
      if (ct.view.getMessages().length >= expected) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

describe('raw-messages integration', () => {
  let agentSession: AgentSessionT | undefined;
  let clientSession: ClientSessionT | undefined;

  afterEach(async () => {
    await clientSession?.close();
    clientSession = undefined;
    await agentSession?.detach();
    agentSession = undefined;
    closeAllClients();
  });

  it('raw Pub/Sub messages interleave with a run: transport unaffected, raw read + serial merge round-trip', async () => {
    const channelName = uniqueChannelName('raw-share');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
    });
    await clientSession.connect();

    // Raw application traffic before the run.
    const channel = clientClient.channels.get(channelName);
    await channel.publish('app.note', { text: 'before the run' });

    // A full transport turn: send -> agent streams a reply -> run ends.
    const activeRun = await clientSession.view.send(
      UIMessageCodec.createUserMessage({
        id: 'user-raw-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello!' }],
      }),
    );
    const serverRun = createRunFromOpts(agentSession, {
      runId: crypto.randomUUID(),
      inputEventId: activeRun.inputEventId,
    });
    await serverRun.start();
    await activeRun.started;
    await serverRun.pipe(textResponseStream('asst-raw-1', 'text-raw-1', 'Hi there!'));
    await serverRun.end({ reason: 'complete' });
    await waitForMessages(clientSession, 2);

    // Raw application traffic after the run.
    await channel.publish('app.note', { text: 'after the run' });

    // The transport's conversation state is unaffected by the raw traffic.
    const conversation = clientSession.view.getMessages();
    expect(conversation).toHaveLength(2);
    expect(conversation.map((m) => m.message.role)).toEqual(['user', 'assistant']);

    // A cold-started reader recovers the raw record from the channel alone;
    // the default isForeignMessage filter drops all the transport's own wire
    // traffic published above.
    const coldClient = ablyRealtimeClient();
    const raw = await fetchRawHistory(coldClient.channels.get(channelName));
    expect(raw.map((m) => m.name)).toEqual(['app.note', 'app.note']);
    expect(raw.map((m) => (m.data as { text: string }).text)).toEqual(['before the run', 'after the run']);

    // The serial merge interleaves the raw record around the conversation in
    // publish order.
    const merged = mergeBySerial(conversation, runStartSerialOf(clientSession.view, clientSession.tree), raw);
    expect(
      merged.map((item) =>
        item.kind === 'conversation' ? item.message.role : (item.message.data as { text: string }).text,
      ),
    ).toEqual(['before the run', 'user', 'assistant', 'after the run']);
  });
});
