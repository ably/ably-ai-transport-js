/**
 * AgentSession integration tests.
 *
 * Validate the full server-side run lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test creates an AgentSession on
 * a unique channel and a separate subscriber client to verify messages
 * arrive correctly.
 *
 * Rewritten against the event-sourced
 * `Codec<TEvent, TProjection, TMessage>` contract — the subscriber
 * decodes via `Decoder.decode()` and folds events into a `VercelProjection`
 * via `init` + `fold`, then reads `getMessages(projection)` to verify the
 * reconstructed conversation.
 */

import '../../helper/expectations.js';

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_AI_OUTPUT,
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';
import type { AgentSession } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { getCodecHeaders, getTransportHeaders } from '../../../src/utils.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { textResponseStream } from '../../integration/helpers.js';

// Merged view of the transport and codec header tiers. The two tiers carry
// disjoint keys, so merging is unambiguous and lets assertions read either
// tier by bare key.
const getHeaders = (msg: Ably.InboundMessage): Record<string, string> => ({
  ...getTransportHeaders(msg),
  ...getCodecHeaders(msg),
});

type AgentSessionT = AgentSession<VercelOutput, VercelProjection, AI.UIMessage>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FoldingCollector {
  allOutputs: VercelOutput[];
  allInputs: VercelInput[];
  rawMessages: Ably.InboundMessage[];
  /** Fully folded projection across all messages observed so far. */
  projection: VercelProjection;
  done: Promise<void>;
}

/**
 * Subscribe to the given channel and decode every inbound message via the
 * codec, folding each event into a per-channel projection. Resolves the
 * returned `done` promise the first time `predicate` returns true for a
 * decoded event batch.
 * @param channel - The Ably channel to subscribe to.
 * @param predicate - Stop collecting when this returns true for a batch of events.
 * @returns A collector with running raw messages, events, and projection state.
 */
const collectUntil = (
  channel: Ably.RealtimeChannel,
  predicate: (outputs: VercelOutput[]) => boolean,
): FoldingCollector => {
  const decoder = UIMessageCodec.createDecoder();
  let projection = UIMessageCodec.init();
  const allInputs: VercelInput[] = [];
  const allOutputs: VercelOutput[] = [];
  const rawMessages: Ably.InboundMessage[] = [];

  let resolve: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  void channel.subscribe((msg) => {
    rawMessages.push(msg);
    const { inputs, outputs } = decoder.decode(msg);
    allInputs.push(...inputs);
    allOutputs.push(...outputs);
    const headers = getHeaders(msg);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    for (const input of inputs) {
      projection = UIMessageCodec.fold(projection, input, { serial: msg.serial ?? '', messageId: codecMessageId });
    }
    for (const output of outputs) {
      projection = UIMessageCodec.fold(projection, output, { serial: msg.serial ?? '', messageId: codecMessageId });
    }
    if (predicate(outputs)) resolve();
  });

  return {
    allInputs,
    allOutputs,
    rawMessages,
    get projection() {
      return projection;
    },
    done,
  };
};

const hasFinish = (outputs: VercelOutput[]): boolean => outputs.some((e) => e.type === 'finish');
const isRunEnd = (msg: Ably.InboundMessage): boolean => msg.name === EVENT_RUN_END;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentSession integration', () => {
  let session: AgentSessionT | undefined;

  afterEach(() => {
    session?.close();
    session = undefined;
    closeAllClients();
  });

  it('streams a text response through the transport', async () => {
    const channelName = uniqueChannelName('st-text');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const collector = collectUntil(subChannel, hasFinish);

    const run = createRunFromOpts(session, { runId: 'run-1' });
    await run.start();

    const stream = textResponseStream('msg-1', 'text-1', 'Hello, world!');
    const result = await run.pipe(stream);
    await run.end('complete');

    await collector.done;

    expect(result.reason).toBe('complete');

    const types = collector.allOutputs.map((o) => o.type);
    expect(types).toContain('start');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');

    const messages = UIMessageCodec.getMessages(collector.projection).map((m) => m.message);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('Hello, world!');

    const streamMsg = collector.rawMessages.find((m) => m.name !== EVENT_RUN_START && m.name !== EVENT_RUN_END);
    expect(streamMsg).toBeDefined();
    if (streamMsg) {
      const headers = getHeaders(streamMsg);
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBeDefined();
    }
  });

  it('stamps inputClientId from the triggering input event publisher; a continuation invocation from a different publisher stamps the new value', async () => {
    // Verifies that the agent reads the publisher's Ably-level `clientId`
    // off the triggering `ai-input` event on the channel and re-stamps it
    // as `input-client-id` on every event it publishes for that
    // invocation. A second invocation triggered by an input from a
    // different publisher stamps the new value while `runClientId` (the
    // run owner) stays the same. The continuation is materialised as an
    // `ai-run-resume` (the triggering input carried a wire run-id),
    // not a second `ai-run-start`.
    const channelName = uniqueChannelName('st-input-client-id');
    const serverClient = ablyRealtimeClient();
    const publisherA = ablyRealtimeClient({ clientId: 'user-a' });
    const publisherB = ablyRealtimeClient({ clientId: 'user-b' });
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const lifecycleMessages: Ably.InboundMessage[] = [];
    const assistantMessages: Ably.InboundMessage[] = [];
    let runEndCount = 0;
    let resolveTwoEnds: () => void;
    const twoEnds = new Promise<void>((r) => {
      resolveTwoEnds = r;
    });

    await subChannel.subscribe((msg) => {
      if (msg.name === EVENT_RUN_START || msg.name === EVENT_RUN_RESUME || msg.name === EVENT_RUN_END) {
        lifecycleMessages.push(msg);
        if (msg.name === EVENT_RUN_END) {
          runEndCount++;
          if (runEndCount === 2) resolveTwoEnds();
        }
      } else if (getHeaders(msg)[HEADER_ROLE] === 'assistant') {
        assistantMessages.push(msg);
      }
    });

    // Capture session into a local so the closure below can reference it
    // without TS widening it back to `AgentSessionT | undefined` across
    // its `await`s.
    const agentSession = session;

    /**
     * Publish an input event on the channel from the given publisher,
     * then start a run that picks it up via the input-event lookup. The
     * publisher's Ably-level `clientId` becomes the `inputClientId` the
     * agent stamps on every published event of the invocation.
     * @param opts - Scenario inputs.
     * @param opts.publisher - Ably Realtime client that publishes the input event.
     * @param opts.runId - Run identifier the agent uses.
     * @param opts.invocationId - Invocation identifier the agent uses.
     * @param opts.codecMessageId - `codec-message-id` for the published input.
     * @param opts.streamArgs - Forwarded to `textResponseStream` for the agent's reply.
     * @param opts.continuation - When true, stamps the run-id on the input wire so the
     *   agent re-enters the run and publishes `ai-run-resume` rather than `ai-run-start`.
     *   A fresh send carries no wire run-id (the agent mints it on run-start).
     */
    const runWithInput = async (opts: {
      publisher: Ably.Realtime;
      runId: string;
      invocationId: string;
      codecMessageId: string;
      streamArgs: [string, string, string];
      continuation?: boolean;
    }): Promise<void> => {
      const inputEventId = crypto.randomUUID();
      const publisherChannel = opts.publisher.channels.get(channelName);
      const headers = buildTransportHeaders({
        role: 'user',
        // A continuation stamps the reused run-id on the wire; a fresh send
        // carries none, signalling the agent to mint one and open the run.
        ...(opts.continuation ? { runId: opts.runId } : {}),
        codecMessageId: opts.codecMessageId,
        inputEventId,
      });
      const encoder = UIMessageCodec.createEncoder(publisherChannel, { extras: { headers } });
      const userInput = UIMessageCodec.createUserMessage({
        id: opts.codecMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      });
      await encoder.publishInput(userInput);

      const run = createRunFromOpts(agentSession, {
        runId: opts.runId,
        invocationId: opts.invocationId,
        inputEventId: inputEventId,
      });
      await run.start();
      await run.pipe(textResponseStream(...opts.streamArgs));
      await run.end('complete');
    };

    const runId = 'run-input-client-id';

    // First invocation: triggered by an input event from user-a.
    await runWithInput({
      publisher: publisherA,
      runId,
      invocationId: 'inv-a',
      codecMessageId: 'm-user-a',
      streamArgs: ['msg-a', 'text-a', 'first reply'],
    });

    // Second invocation: same runId, input event from user-b — emulates
    // a non-owner-driven continuation (e.g. a tool-result publish from
    // 'user-b'). The agent stamps inputClientId: user-b on every event
    // of this invocation.
    await runWithInput({
      publisher: publisherB,
      runId,
      invocationId: 'inv-b',
      codecMessageId: 'm-user-b',
      streamArgs: ['msg-b', 'text-b', 'second reply'],
      continuation: true,
    });

    await twoEnds;

    // The fresh first invocation opens the run with ai-run-start; the
    // continuation (inv-b, input carries the wire run-id) re-enters it with
    // ai-run-resume.
    const startMsgs = lifecycleMessages.filter((m) => m.name === EVENT_RUN_START);
    const resumeMsgs = lifecycleMessages.filter((m) => m.name === EVENT_RUN_RESUME);
    const endMsgs = lifecycleMessages.filter((m) => m.name === EVENT_RUN_END);
    expect(startMsgs).toHaveLength(1);
    expect(resumeMsgs).toHaveLength(1);
    expect(endMsgs).toHaveLength(2);

    const startA = startMsgs.find((m) => getHeaders(m)[HEADER_INVOCATION_ID] === 'inv-a');
    const resumeB = resumeMsgs.find((m) => getHeaders(m)[HEADER_INVOCATION_ID] === 'inv-b');
    expect(startA).toBeDefined();
    expect(resumeB).toBeDefined();
    if (!startA || !resumeB) return;
    expect(getHeaders(startA)[HEADER_INPUT_CLIENT_ID]).toBe('user-a');
    expect(getHeaders(resumeB)[HEADER_INPUT_CLIENT_ID]).toBe('user-b');

    // The triggering input's codec-message-id is threaded through every event
    // of the invocation (run-start / run-resume, run-end, assistant outputs),
    // mirroring input-client-id, so the client can correlate any of them back
    // to the originating input by the id it owns at send time.
    expect(getHeaders(startA)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('m-user-a');
    expect(getHeaders(resumeB)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('m-user-b');

    const endA = endMsgs.find((m) => getHeaders(m)[HEADER_INVOCATION_ID] === 'inv-a');
    const endB = endMsgs.find((m) => getHeaders(m)[HEADER_INVOCATION_ID] === 'inv-b');
    expect(endA).toBeDefined();
    expect(endB).toBeDefined();
    if (!endA || !endB) return;
    expect(getHeaders(endA)[HEADER_INPUT_CLIENT_ID]).toBe('user-a');
    expect(getHeaders(endB)[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    expect(getHeaders(endA)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('m-user-a');
    expect(getHeaders(endB)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('m-user-b');

    // Assistant outputs of each invocation also carry the input event's
    // publisher id. Both invocations share `runId`, so we partition by
    // serial: messages before the continuation's run-resume belong to inv-a,
    // the rest to inv-b. Serials are lexicographically ordered across the channel.
    const cutoffSerial = resumeB.serial;
    expect(cutoffSerial).toBeDefined();
    if (cutoffSerial === undefined) return;
    const assistantA = assistantMessages.find((m) => (m.serial ?? '') < cutoffSerial);
    const assistantB = assistantMessages.find((m) => (m.serial ?? '') >= cutoffSerial);
    expect(assistantA).toBeDefined();
    expect(assistantB).toBeDefined();
    if (!assistantA || !assistantB) return;
    expect(getHeaders(assistantA)[HEADER_INPUT_CLIENT_ID]).toBe('user-a');
    expect(getHeaders(assistantB)[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
    expect(getHeaders(assistantA)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('m-user-a');
    expect(getHeaders(assistantB)[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe('m-user-b');
    // ...and the continuing invocation's invocation-id: outputs published after
    // the run-resume carry inv-b, not the run-opening inv-a. The agent stamps
    // invocation-id from the per-invocation createRun, so a resume threads the
    // continuing invocation's id through its outputs just as run-resume / run-end do.
    expect(getHeaders(assistantA)[HEADER_INVOCATION_ID]).toBe('inv-a');
    expect(getHeaders(assistantB)[HEADER_INVOCATION_ID]).toBe('inv-b');
  });

  it('publishes run-start and run-end events', async () => {
    const channelName = uniqueChannelName('st-lifecycle');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const lifecycleMessages: Ably.InboundMessage[] = [];
    let resolveEnd: () => void;
    const gotEnd = new Promise<void>((r) => {
      resolveEnd = r;
    });

    await subChannel.subscribe((msg) => {
      lifecycleMessages.push(msg);
      if (isRunEnd(msg)) resolveEnd();
    });

    const run = createRunFromOpts(session, { runId: 'run-lc-1' });
    await run.start();

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await run.pipe(stream);
    await run.end('complete');

    await gotEnd;

    const startMsg = lifecycleMessages.find((m) => m.name === EVENT_RUN_START);
    expect(startMsg).toBeDefined();
    if (startMsg) {
      const startHeaders = getHeaders(startMsg);
      expect(startHeaders[HEADER_RUN_ID]).toBe('run-lc-1');
    }

    const endMsg = lifecycleMessages.find((m) => m.name === EVENT_RUN_END);
    expect(endMsg).toBeDefined();
    if (endMsg) {
      const endHeaders = getHeaders(endMsg);
      expect(endHeaders[HEADER_RUN_ID]).toBe('run-lc-1');
      expect(endHeaders[HEADER_RUN_REASON]).toBe('complete');
    }
  });

  it('cancels a run via channel cancel message', async () => {
    const channelName = uniqueChannelName('st-cancel');
    const serverClient = ablyRealtimeClient();
    const cancelClient = ablyRealtimeClient();
    const cancelChannel = cancelClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-cancel-1' });
    await run.start();

    const stream = new ReadableStream<VercelOutput>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: 'msg-cancel-1' });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-cancel-1' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-cancel-1', delta: 'Partial...' });
      },
    });

    const streamPromise = run.pipe(stream);
    await new Promise((r) => setTimeout(r, 500));

    await cancelChannel.publish({
      name: EVENT_CANCEL,
      extras: { ai: { transport: { [HEADER_RUN_ID]: 'run-cancel-1' } } },
    });

    const result = await streamPromise;
    expect(result.reason).toBe('cancelled');
    expect(run.abortSignal.aborted).toBe(true);
    await run.end('cancelled');
  });

  it('handles sequential runs', async () => {
    const channelName = uniqueChannelName('st-multi-run');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    let projection = UIMessageCodec.init();
    const decoder = UIMessageCodec.createDecoder();
    let finishCount = 0;
    let resolveTwoFinishes: () => void;
    const twoFinishes = new Promise<void>((r) => {
      resolveTwoFinishes = r;
    });

    await subChannel.subscribe((msg) => {
      const { inputs, outputs } = decoder.decode(msg);
      const headers = getHeaders(msg);
      const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
      for (const event of inputs) {
        projection = UIMessageCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: codecMessageId });
      }
      for (const event of outputs) {
        projection = UIMessageCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: codecMessageId });
      }
      if (outputs.some((e) => e.type === 'finish')) {
        finishCount++;
        if (finishCount === 2) resolveTwoFinishes();
      }
    });

    const run1 = createRunFromOpts(session, { runId: 'run-seq-1' });
    await run1.start();
    const result1 = await run1.pipe(textResponseStream('msg-seq-1', 'text-seq-1', 'First response'));
    await run1.end('complete');
    expect(result1.reason).toBe('complete');

    const run2 = createRunFromOpts(session, { runId: 'run-seq-2' });
    await run2.start();
    const result2 = await run2.pipe(textResponseStream('msg-seq-2', 'text-seq-2', 'Second response'));
    await run2.end('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(2);
  });

  it('handles concurrent runs', async () => {
    const channelName = uniqueChannelName('st-concurrent');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let finishCount = 0;
    let resolveTwoFinishes: () => void;
    const twoFinishes = new Promise<void>((r) => {
      resolveTwoFinishes = r;
    });

    const decoder = UIMessageCodec.createDecoder();
    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      const { outputs } = decoder.decode(msg);
      if (outputs.some((e) => e.type === 'finish')) {
        finishCount++;
        if (finishCount === 2) resolveTwoFinishes();
      }
    });

    const run1 = createRunFromOpts(session, { runId: 'run-conc-1' });
    const run2 = createRunFromOpts(session, { runId: 'run-conc-2' });

    await Promise.all([run1.start(), run2.start()]);

    const [result1, result2] = await Promise.all([
      run1.pipe(textResponseStream('msg-conc-1', 'text-conc-1', 'Response A')),
      run2.pipe(textResponseStream('msg-conc-2', 'text-conc-2', 'Response B')),
    ]);

    await Promise.all([run1.end('complete'), run2.end('complete')]);

    expect(result1.reason).toBe('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    const runIds = new Set(rawMessages.map((m) => getHeaders(m)[HEADER_RUN_ID]).filter(Boolean));
    expect(runIds.has('run-conc-1')).toBe(true);
    expect(runIds.has('run-conc-2')).toBe(true);
  });

  it('propagates stream errors', async () => {
    const channelName = uniqueChannelName('st-error');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let resolveEnd: () => void;
    const gotEnd = new Promise<void>((r) => {
      resolveEnd = r;
    });

    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      if (isRunEnd(msg)) resolveEnd();
    });

    const run = createRunFromOpts(session, { runId: 'run-err-1' });
    await run.start();

    const stream = new ReadableStream<VercelOutput>({
      start: (controller) => {
        controller.enqueue({ type: 'start', messageId: 'msg-err-1' });
        controller.enqueue({ type: 'start-step' });
        controller.enqueue({ type: 'text-start', id: 'text-err-1' });
        controller.enqueue({ type: 'text-delta', id: 'text-err-1', delta: 'Partial...' });
        controller.error(new Error('model rate limit exceeded'));
      },
    });

    const result = await run.pipe(stream);
    expect(result.reason).toBe('error');

    await run.end('error');
    await gotEnd;

    const endMsg = rawMessages.find((m) => m.name === EVENT_RUN_END);
    expect(endMsg).toBeDefined();
    if (endMsg) {
      expect(getHeaders(endMsg)[HEADER_RUN_REASON]).toBe('error');
    }
  });

  it('multiple subscribers receive the same stream', async () => {
    const channelName = uniqueChannelName('st-sync');
    const serverClient = ablyRealtimeClient();
    const sub1Client = ablyRealtimeClient();
    const sub2Client = ablyRealtimeClient();
    const sub1Channel = sub1Client.channels.get(channelName);
    const sub2Channel = sub2Client.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const c1 = collectUntil(sub1Channel, hasFinish);
    const c2 = collectUntil(sub2Channel, hasFinish);

    const run = createRunFromOpts(session, { runId: 'run-sync-1' });
    await run.start();
    await run.pipe(textResponseStream('msg-sync-1', 'text-sync-1', 'Shared response'));
    await run.end('complete');

    await Promise.all([c1.done, c2.done]);

    const m1 = UIMessageCodec.getMessages(c1.projection).map((m) => m.message);
    const m2 = UIMessageCodec.getMessages(c2.projection).map((m) => m.message);
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);

    const text1 = m1[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    const text2 = m2[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(text1?.text).toBe('Shared response');
    expect(text2?.text).toBe('Shared response');
  });

  it('invokes onError with ChannelContinuityLost when the channel detaches', async () => {
    const channelName = uniqueChannelName('st-continuity');
    const serverClient = ablyRealtimeClient();

    const errors: Ably.ErrorInfo[] = [];

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      onError: (err) => errors.push(err),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1' });
    await run.start();

    await serverClient.channels.get(channelName).detach();

    await vi.waitFor(
      () => {
        expect(errors.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);
  });

  it('stamps per-event WriteOptions overrides on discrete publishes', async () => {
    const channelName = uniqueChannelName('st-resolve-write-options');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let resolve: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const isToolOutputAvailable = (msg: Ably.InboundMessage): boolean =>
      msg.name === EVENT_AI_OUTPUT && getHeaders(msg).type === 'tool-output-available';
    const isText = (msg: Ably.InboundMessage): boolean =>
      msg.name === EVENT_AI_OUTPUT && getHeaders(msg).type === 'text';
    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      if (isToolOutputAvailable(msg)) resolve();
    });

    const run = createRunFromOpts(session, { runId: 'run-rwo' });
    await run.start();

    const stream = new ReadableStream<VercelOutput>({
      start: (controller) => {
        controller.enqueue({ type: 'text-start', id: 'txt-1' });
        controller.enqueue({
          type: 'tool-output-available',
          toolCallId: 't1',
          output: { result: 'ok' },
          dynamic: true,
          providerExecuted: false,
          preliminary: false,
        });
        controller.close();
      },
    });

    await run.pipe(stream, {
      resolveWriteOptions: (event: VercelOutput) =>
        event.type === 'tool-output-available' ? { messageId: 'target-codec-message-id' } : undefined,
    });

    await done;

    const textStartMsg = rawMessages.find((m) => isText(m));
    expect(textStartMsg).toBeDefined();
    if (textStartMsg) {
      const textHeaders = getHeaders(textStartMsg);
      expect(textHeaders[HEADER_CODEC_MESSAGE_ID]).not.toBe('target-codec-message-id');
    }

    const toolMsg = rawMessages.find((m) => isToolOutputAvailable(m));
    expect(toolMsg).toBeDefined();
    if (toolMsg) {
      const toolHeaders = getHeaders(toolMsg);
      expect(toolHeaders[HEADER_CODEC_MESSAGE_ID]).toBe('target-codec-message-id');
    }

    await run.end('complete');
  });

  /**
   * Scenario: forward-looking live wait for an input event.
   *
   * The agent registers its input-event lookup listener BEFORE the client
   * publishes the user message — exercising the live-wait path inside
   * `lookupInputEvents` (not the rewind/buffer-drain path that other
   * tests in this file cover). The lookup must pick the message up as
   * it arrives live and resolve `run.start()`.
   *
   * Pre-allocating the runId / inputEventId is what makes this
   * orderable: the agent can stand up its run with known identifiers
   * and call `start()` first, then the publisher publishes a message
   * tagged with the same inputEventId.
   */
  it('collects an input event that arrives live after the lookup is registered', async () => {
    const channelName = uniqueChannelName('st-live-lookup');
    const serverClient = ablyRealtimeClient();
    const publisherClient = ablyRealtimeClient();

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Default `inputEventLookupTimeoutMs` — the live wait must succeed
      // well before the 30s default.
    });
    await session.connect();

    const runId = crypto.randomUUID();
    const codecMessageId = crypto.randomUUID();
    const text = 'Live arrival';

    const inputEventId = crypto.randomUUID();
    const serverRun = createRunFromOpts(session, {
      runId,
      inputEventId: inputEventId,
    });

    // Begin the lookup. `start()` will not resolve until an input event
    // with the expected `inputEventId` arrives — and that message has not been
    // published yet.
    const startPromise = serverRun.start();

    // Publish the input event from a separate client after the lookup
    // has had a chance to register. A short sleep here is enough to
    // ensure `start()` has crossed the requireConnected await and
    // installed the listener; the lookup itself has a 30s budget so
    // a few hundred ms is safe.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const publisherChannel = publisherClient.channels.get(channelName);
    const headers = buildTransportHeaders({ role: 'user', runId, codecMessageId, inputEventId });
    const encoder = UIMessageCodec.createEncoder(publisherChannel, { extras: { headers } });
    const userInput = UIMessageCodec.createUserMessage({
      id: codecMessageId,
      role: 'user',
      parts: [{ type: 'text', text }],
    });
    await encoder.publishInput(userInput);

    await startPromise;

    expect(serverRun.view.messages).toHaveLength(1);
    const found = serverRun.view.messages[0];
    expect(found?.codecMessageId).toBe(codecMessageId);
    expect(found?.message.parts[0]).toEqual({ type: 'text', text });

    await serverRun.end('complete');
  });

  /**
   * Scenario: multi-message `send([m1, m2])` round-trip.
   *
   * In the two-node model the client publishes each user message as its own
   * run-less input node (chained by `parent`). The agent's `start()` lookup
   * collects the primary trigger (the last message); the full prompt chain is
   * reconstructed via `loadConversation()`, which walks the input nodes'
   * structural parent chain and folds each, surfacing both messages in publish
   * order on `run.messages`. The agent then pipes an assistant response that
   * the client receives.
   *
   * This is the regression test for PR #90: previously the lookup settled
   * on the first matching arrival and dropped subsequent messages.
   */
  it('reconstructs all messages of a multi-message send via loadConversation', async () => {
    // Lazy-import to keep the existing test imports above stable.
    const { createClientSession } = await import('../../../src/core/transport/client-session.js');
    const channelName = uniqueChannelName('st-multi-msg');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Use the default inputEventLookupTimeoutMs so the real lookup path runs.
    });
    await session.connect();

    const clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      // `send()` would otherwise block awaiting `ai-run-start` — but
      // the agent only publishes that AFTER its lookup resolves, which
      // requires `send()` to publish the user messages first. The
      // happy-path run-start wait is exercised in client-session integration
      // tests (Commit 2); this test focuses on the lookup itself.
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    try {
      const activeRun = await clientSession.view.send([
        UIMessageCodec.createUserMessage({
          id: 'user-multi-1',
          role: 'user',
          parts: [{ type: 'text', text: 'First' }],
        }),
        UIMessageCodec.createUserMessage({
          id: 'user-multi-2',
          role: 'user',
          parts: [{ type: 'text', text: 'Second' }],
        }),
      ]);

      // The agent is the run-id authority: it mints the reply run-id and
      // drives off the client's input event. The client's `run.runId` resolves
      // to this minted id once run-start lands.
      const mintedRunId = crypto.randomUUID();
      const serverRun = createRunFromOpts(session, {
        runId: mintedRunId,
        inputEventId: activeRun.inputEventId,
      });
      await serverRun.start();
      const runId = await activeRun.runId;
      expect(runId).toBe(mintedRunId);
      // start() only collects the primary trigger event (the last message of
      // the send). The full prompt chain — both run-less input nodes — is
      // reconstructed by loadConversation(), which reads channel.history()
      // (eventually consistent) and walks the input nodes' parent chain. Retry
      // until both have been indexed rather than asserting after a single read.
      let messages = serverRun.messages;
      await vi.waitFor(
        async () => {
          await serverRun.loadConversation();
          messages = serverRun.messages;
          expect(messages).toHaveLength(2);
        },
        { timeout: 10_000 },
      );

      const ids = messages.map((m) => m.id);
      expect(ids).toEqual(['user-multi-1', 'user-multi-2']);
      const firstText = messages[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;
      const secondText = messages[1]?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;
      expect(firstText).toBe('First');
      expect(secondText).toBe('Second');

      // Streaming was hoisted out of the core, so the response reaches the
      // client on the Tree's `output` event rather than an ActiveRun stream.
      // Collect outputs for this run until its terminal run-end lands.
      const events: VercelOutput[] = [];
      const outputsPromise = new Promise<VercelOutput[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubOutput();
          unsubRun();
          reject(new Error('timed out collecting run outputs'));
        }, 10_000);
        const unsubOutput = clientSession.tree.on('output', (e) => {
          if (e.runId === runId) events.push(...e.events);
        });
        const unsubRun = clientSession.tree.on('run', (e) => {
          if (e.runId === runId && e.type === 'end') {
            clearTimeout(timer);
            unsubOutput();
            unsubRun();
            resolve(events);
          }
        });
      });

      const responseStream = textResponseStream('asst-multi-1', 'text-multi-1', 'Got both');
      const result = await serverRun.pipe(responseStream);
      await serverRun.end('complete');
      expect(result.reason).toBe('complete');

      await outputsPromise;
      expect(events.some((e) => e.type === 'finish')).toBe(true);
    } finally {
      await clientSession.close();
    }
  });
});
