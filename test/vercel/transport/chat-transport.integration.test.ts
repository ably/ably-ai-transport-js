/**
 * Concurrent client-tool-result integration test (real Ably).
 *
 * Two sessions with the SAME clientId (e.g. two browser tabs) both execute the
 * same client-side tool call (`getLocation`) on ONE suspended run and each
 * submit a DIFFERENT result. The two results must be SEGREGATED onto two
 * distinct reply-run branches — one "Hong Kong", one "Berlin" — instead of
 * contaminating a single run, where both results collapse onto the one
 * tool-call assistant (last-writer-wins) and only one survives.
 *
 * Driven end-to-end over real Ably through the real Vercel chat transport — the
 * layer that decides how a client tool-result continuation is dispatched — so
 * the test exercises the actual client continuation path (not a hand-built
 * wire). The suspended trunk is set up with a real agent run; the two tabs then
 * resolve the tool concurrently via `createChatTransport(...).sendMessages`.
 *
 * The segregation is observed on a third (observer) session's conversation
 * tree: the reply-run branches parented at the prompt (`getSiblingNodes`) must
 * carry the two results one-per-branch. On unfixed code both continuations
 * reuse the suspended run's id, so the observer sees a single branch whose
 * tool-call assistant shows only the last-written result — this test is RED.
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import type {
  AgentSession,
  ClientSession,
  ConversationNode,
  OpenableRun,
  OutputEvent,
  RunNode,
} from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { isToolPart } from '../../../src/vercel/tool-part.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { textResponseStream } from '../../integration/helpers.js';

const UIMessageCodec = createUIMessageCodec();

type ClientSessionT = ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
type AgentSessionT = AgentSession<VercelOutput, VercelProjection, AI.UIMessage>;

const TOOL_CALL_ID = 'tc-loc';
const ASSISTANT_ID = 'asst-tool';
const TRUNK_RUN_ID = 'run-trunk';

// A no-op agent-wake POST: the chat transport publishes the continuation on the
// channel BEFORE POSTing, so the POST need only succeed.
// eslint-disable-next-line @typescript-eslint/promise-function-async -- stub returns a resolved Response directly
const noopFetch: typeof globalThis.fetch = () => Promise.resolve(new Response(undefined, { status: 200 }));

// The agent's first segment: a client-tool call, then finish (the run suspends after).
const toolCallStream = (messageId: string, toolCallId: string): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue({ type: 'start', messageId });
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'tool-input-start', toolCallId, toolName: 'getLocation', dynamic: true });
      controller.enqueue({
        type: 'tool-input-available',
        toolCallId,
        toolName: 'getLocation',
        input: {},
        dynamic: true,
      });
      controller.enqueue({ type: 'finish', finishReason: 'tool-calls' });
      controller.close();
    },
  });

// The useChat overlay for one tab: the prompt plus the assistant with the tool executed to `city`.
const overlayFor = (city: string): AI.UIMessage[] => [
  { id: 'user-weather', role: 'user', parts: [{ type: 'text', text: 'What is the weather where I am?' }] },
  {
    id: ASSISTANT_ID,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: TOOL_CALL_ID,
        state: 'output-available',
        input: {},
        output: { city },
      },
    ],
  },
];

// Resolve once the session's visible conversation shows the `getLocation` tool
// call in `input-available` (unresolved).
// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body IS a Promise executor
const awaitUnresolvedToolCall = (session: ClientSessionT, timeoutMs = 15_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const seen = (): boolean =>
      session.view
        .getMessages()
        .some(({ message }) =>
          message.parts.some((p) => isToolPart(p) && p.toolCallId === TOOL_CALL_ID && p.state === 'input-available'),
        );
    if (seen()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('timed out waiting for the unresolved tool call to fold'));
    }, timeoutMs);
    const unsub = session.tree.on('output', () => {
      if (seen()) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

// Resolve once `count` input folds (an `output` event carrying no output
// events — i.e. a client input fold) have been observed since arming.
// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body IS a Promise executor
const awaitInputFolds = (session: ClientSessionT, count: number, timeoutMs = 15_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${String(count)} input folds; saw ${String(seen)}`));
    }, timeoutMs);
    const unsub = session.tree.on('output', (e: OutputEvent<VercelOutput>) => {
      if (e.events.length > 0) return;
      seen += 1;
      if (seen >= count) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

// The `getLocation` result cities resolved within one reply-run branch's own projection.
const resolvedCitiesOf = (run: RunNode<VercelProjection>): string[] => {
  const cities: string[] = [];
  for (const { message } of UIMessageCodec.getMessages(run.projection)) {
    for (const part of message.parts) {
      if (isToolPart(part) && part.toolCallId === TOOL_CALL_ID && part.state === 'output-available') {
        cities.push((part.output as { city?: string }).city ?? '');
      }
    }
  }
  return cities;
};

// Read a `{ city }` tool output without an assertion — the wire boundary keeps
// tool output `unknown`, so narrow it structurally rather than casting.
const cityOfOutput = (output: unknown): string | undefined =>
  typeof output === 'object' && output !== null && 'city' in output && typeof output.city === 'string'
    ? output.city
    : undefined;

// The `getLocation` result cities resolved (output-available) across a flat
// message list — used on the agent's reconstructed prompt (`run.view`).
const resolvedCitiesInMessages = (messages: AI.UIMessage[]): string[] => {
  const cities: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolPart(part) && part.toolCallId === TOOL_CALL_ID && part.state === 'output-available') {
        const city = cityOfOutput(part.output);
        if (city !== undefined) cities.push(city);
      }
    }
  }
  return cities;
};

// The text-part contents across a flat message list — used to check that each
// fork's own follow-up is present and the sibling's is not.
const textsInMessages = (messages: AI.UIMessage[]): string[] =>
  messages
    .flatMap((m) => m.parts)
    .filter((p): p is AI.TextUIPart => p.type === 'text')
    .map((p) => p.text);

describe('concurrent client tool results for one suspended tool call', () => {
  let agent: AgentSessionT | undefined;

  afterEach(async () => {
    await agent?.detach();
    agent = undefined;
    closeAllClients();
  });

  it("segregates two clients' results onto two distinct reply-run branches, one per result", async () => {
    const { createClientSession } = await import('../../../src/core/transport/client-session.js');
    const channelName = uniqueChannelName('cc-tool-results');

    const agentClient = ablyRealtimeClient();
    // Two tabs share ONE clientId — the concurrent same-clientId two-tab scenario.
    const tabAClient = ablyRealtimeClient({ clientId: 'user-a' });
    const tabBClient = ablyRealtimeClient({ clientId: 'user-a' });
    const observerClient = ablyRealtimeClient();

    agent = createAgentSession({ client: agentClient, channelName, codec: UIMessageCodec });
    await agent.connect();
    const agentSession = agent;

    const tabA = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: tabAClient,
      channelName,
      codec: UIMessageCodec,
    });
    const tabB = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: tabBClient,
      channelName,
      codec: UIMessageCodec,
    });
    const observer = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: observerClient,
      channelName,
      codec: UIMessageCodec,
    });
    await Promise.all([tabA.connect(), tabB.connect(), observer.connect()]);

    try {
      // --- Trunk: tab A sends the prompt; the agent streams the getLocation
      // tool call and SUSPENDS, leaving the run live awaiting a result. ---
      const turn = await tabA.view.send(
        UIMessageCodec.createUserMessage({
          id: 'user-weather',
          role: 'user',
          parts: [{ type: 'text', text: 'What is the weather where I am?' }],
        }),
      );

      const trunk = createRunFromOpts(agentSession, { runId: TRUNK_RUN_ID, inputEventId: turn.inputEventId });
      await trunk.start();
      await turn.started;
      await trunk.pipe(toolCallStream(ASSISTANT_ID, TOOL_CALL_ID));
      await trunk.suspend();

      // Both tabs (which will resolve) and the observer (which asserts) must see
      // the unresolved tool call before the continuations fire.
      await Promise.all([
        awaitUnresolvedToolCall(tabA),
        awaitUnresolvedToolCall(tabB),
        awaitUnresolvedToolCall(observer),
      ]);

      // Arm the observer to wait for BOTH client tool-result continuations to
      // fold, before they are published.
      const bothFolded = awaitInputFolds(observer, 2);

      // --- Both tabs resolve the SAME tool call CONCURRENTLY via the real chat
      // transport. Each derives its continuation from its own tree in the same
      // tick, before either result echoes back, so neither defers. ---
      const chatA = createChatTransport(tabA, { fetch: noopFetch });
      const chatB = createChatTransport(tabB, { fetch: noopFetch });

      const dispatches = [
        chatA.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-cc',
          messageId: undefined,
          messages: overlayFor('Hong Kong'),
          abortSignal: undefined,
        }),
        chatB.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-cc',
          messageId: undefined,
          messages: overlayFor('Berlin'),
          abortSignal: undefined,
        }),
      ];
      await Promise.all(dispatches);
      await bothFolded;

      // --- Assert on the observer's conversation tree ---
      // The reply-run branches parented at the prompt (the same-parent sibling
      // group of the suspended trunk run).
      const branches = observer.tree
        .getSiblingNodes(TRUNK_RUN_ID)
        .filter((n: ConversationNode<VercelProjection>): n is RunNode<VercelProjection> => n.kind === 'run');

      // Each of the two results lands on its OWN reply-run branch, so the two
      // resolved results are segregated: one "Hong Kong", one "Berlin".
      //
      // On unfixed code both continuations re-enter the single suspended run, so
      // there is ONE branch whose tool-call assistant shows only the
      // last-written result — this expectation fails RED.
      expect(branches.length).toBeGreaterThanOrEqual(2);

      const cities = branches.flatMap((branch) => resolvedCitiesOf(branch));
      expect(cities).toHaveLength(2);
      expect(cities).toContain('Hong Kong');
      expect(cities).toContain('Berlin');

      // Each branch carries exactly one result — no branch mixes both.
      for (const branch of branches) {
        expect(resolvedCitiesOf(branch).length).toBeLessThanOrEqual(1);
      }
    } finally {
      await Promise.all([tabA.close(), tabB.close(), observer.close()]);
    }
  });

  it("gives each fork run a clean agent prompt — its own result and follow-up, never the sibling's", async () => {
    const { createClientSession } = await import('../../../src/core/transport/client-session.js');
    const channelName = uniqueChannelName('cc-tool-prompt');

    const agentClient = ablyRealtimeClient();
    // Two tabs share ONE clientId — the concurrent-tabs scenario.
    const tabAClient = ablyRealtimeClient({ clientId: 'user-a' });
    const tabBClient = ablyRealtimeClient({ clientId: 'user-a' });
    const observerClient = ablyRealtimeClient();

    agent = createAgentSession({ client: agentClient, channelName, codec: UIMessageCodec });
    await agent.connect();
    const agentSession = agent;

    const tabA = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: tabAClient,
      channelName,
      codec: UIMessageCodec,
    });
    const tabB = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: tabBClient,
      channelName,
      codec: UIMessageCodec,
    });
    const observer = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: observerClient,
      channelName,
      codec: UIMessageCodec,
    });
    await Promise.all([tabA.connect(), tabB.connect(), observer.connect()]);

    // Capture each continuation POST's invocation so the agent responder can be
    // driven off the exact triggering input event, as a real agent server would
    // parse the POST body. The POST fires synchronously inside sendMessages, so
    // both ids are captured by the time the dispatches resolve.
    const forkInputEventIds: string[] = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- stub returns a resolved Response directly
    const capturingFetch: typeof globalThis.fetch = (_input, requestInit) => {
      const body = requestInit?.body;
      if (typeof body === 'string') {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'inputEventId' in parsed &&
          typeof parsed.inputEventId === 'string'
        ) {
          forkInputEventIds.push(parsed.inputEventId);
        }
      }
      return Promise.resolve(new Response(undefined, { status: 200 }));
    };

    // Resolve once this run's reconstructed prompt (`run.view`) satisfies
    // `predicate` — the fold may arrive after `start()` / `pipe()` resolve,
    // since the agent's own publishes fold back over the channel round-trip.
    const awaitView = async (
      run: OpenableRun<VercelOutput, VercelProjection, AI.UIMessage>,
      predicate: (messages: AI.UIMessage[]) => boolean,
      label: string,
      timeoutMs = 15_000,
    ): Promise<void> => {
      const check = (): boolean => predicate(run.view.getMessages().map((m) => m.message));
      await new Promise<void>((resolve, reject) => {
        if (check()) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const unsub = agentSession.tree.on('update', () => {
          if (check()) {
            clearTimeout(timer);
            unsub();
            resolve();
          }
        });
      });
    };

    try {
      // --- Trunk: tab A prompts; the agent streams the getLocation tool call
      // and SUSPENDS, leaving the run live awaiting a result. ---
      const turn = await tabA.view.send(
        UIMessageCodec.createUserMessage({
          id: 'user-weather',
          role: 'user',
          parts: [{ type: 'text', text: 'What is the weather where I am?' }],
        }),
      );
      const trunk = createRunFromOpts(agentSession, { runId: TRUNK_RUN_ID, inputEventId: turn.inputEventId });
      await trunk.start();
      await turn.started;
      await trunk.pipe(toolCallStream(ASSISTANT_ID, TOOL_CALL_ID));
      await trunk.suspend();

      await Promise.all([
        awaitUnresolvedToolCall(tabA),
        awaitUnresolvedToolCall(tabB),
        awaitUnresolvedToolCall(observer),
      ]);

      // --- Both tabs resolve the SAME tool call concurrently; each continuation
      // forks into its own reply run. ---
      const bothFolded = awaitInputFolds(observer, 2);
      const chatA = createChatTransport(tabA, { fetch: capturingFetch });
      const chatB = createChatTransport(tabB, { fetch: capturingFetch });
      await Promise.all([
        chatA.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-cc',
          messageId: undefined,
          messages: overlayFor('Hong Kong'),
          abortSignal: undefined,
        }),
        chatB.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-cc',
          messageId: undefined,
          messages: overlayFor('Berlin'),
          abortSignal: undefined,
        }),
      ]);
      await bothFolded;

      expect(forkInputEventIds).toHaveLength(2);

      // --- An agent responder drives a follow-up for EACH fork run, off the
      // fork's own triggering input event (as a real agent server would from the
      // POST body). Start + pipe BOTH before ending either, so both fork runs
      // coexist as siblings when the prompts are read (`run.view` closes on end). ---
      const forkRuns: { run: OpenableRun<VercelOutput, VercelProjection, AI.UIMessage>; city: string; text: string }[] =
        [];
      for (const inputEventId of forkInputEventIds) {
        const run = createRunFromOpts(agentSession, { runId: crypto.randomUUID(), inputEventId });
        await run.start();
        while (run.view.hasOlder()) await run.view.loadOlder();
        await awaitView(run, (messages) => resolvedCitiesInMessages(messages).length > 0, 'the fork result to fold');

        // The prompt the agent would send the LLM for this fork: the user
        // question plus THIS fork's reconstructed tool-call assistant carrying
        // its own result — exactly one resolved city, never the sibling's.
        const promptAtStart = run.view.getMessages().map((m) => m.message);
        const cities = resolvedCitiesInMessages(promptAtStart);
        expect(cities).toHaveLength(1);
        const city = cities[0] ?? '';
        const text = `The weather in ${city} is sunny.`;

        await run.pipe(textResponseStream(`asst-follow-${city}`, `text-follow-${city}`, text));
        await awaitView(run, (messages) => textsInMessages(messages).includes(text), 'the follow-up to fold');
        forkRuns.push({ run, city, text });
      }

      // Two distinct fork runs, one per result.
      expect(new Set(forkRuns.map((f) => f.run.runId)).size).toBe(2);
      expect(forkRuns.map((f) => f.city).toSorted()).toEqual(['Berlin', 'Hong Kong']);

      // With BOTH fork runs live (each a sibling of the other), each fork's agent
      // prompt still holds ONLY its own result and its own follow-up — never the
      // sibling's. This is the core guarantee: each invocation's prompt is clean
      // structurally, not by timing.
      for (const fork of forkRuns) {
        const sibling = forkRuns.find((f) => f.run.runId !== fork.run.runId);
        if (!sibling) throw new Error('expected a sibling fork run');
        const prompt = fork.run.view.getMessages().map((m) => m.message);
        const cities = resolvedCitiesInMessages(prompt);
        const texts = textsInMessages(prompt);
        expect(cities).toEqual([fork.city]);
        expect(texts).toContain(fork.text);
        expect(cities).not.toContain(sibling.city);
        expect(texts).not.toContain(sibling.text);
      }

      for (const fork of forkRuns) await fork.run.end({ reason: 'complete' });
    } finally {
      await Promise.all([tabA.close(), tabB.close(), observer.close()]);
    }
  });
});

// ---------------------------------------------------------------------------
// Sequential (multi-step) client tool results across forked reply runs
// ---------------------------------------------------------------------------
//
// One client, one tab, two client tool calls answered in sequence. The agent
// asks for a FIRST client tool call and suspends; the client resolves it,
// forking reply run F1. F1's agent asks for a SECOND client tool call and
// suspends; the client resolves that, forking reply run F2. Because EVERY
// client tool-result forks its own reply run, F2's fork carries a seed of F1's
// FULL message list — the already-resolved first tool call AND the second — so
// the agent prompt F2 reconstructs (`run.view.getMessages()`) keeps the whole
// step sequence rather than only the latest tool call.
//
// The tests above cover a single fork level answered concurrently; this drives
// the two-level SEQUENTIAL reconstruction end-to-end over real Ably and asserts
// F2's prompt. On a single-message fork seed (carrying only the current
// tool-call assistant) F2's prompt would hold only the second tool call — the
// first would be lost — so the key assertion here fails RED.

// A client tool call the agent streams, then finishes so the run can suspend.
const clientToolCallStream = (
  messageId: string,
  toolName: string,
  toolCallId: string,
): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue({ type: 'start', messageId });
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'tool-input-start', toolCallId, toolName, dynamic: true });
      controller.enqueue({ type: 'tool-input-available', toolCallId, toolName, input: {}, dynamic: true });
      controller.enqueue({ type: 'finish', finishReason: 'tool-calls' });
      controller.close();
    },
  });

// The flat domain-message list a view exposes (dropping the codec-message-id
// pairing), for feeding the tool-part predicates below.
const flatMessagesOf = (view: { getMessages: () => { message: AI.UIMessage }[] }): AI.UIMessage[] =>
  view.getMessages().map((entry) => entry.message);

// The tool output resolved (output-available) for a given tool call across a
// flat message list, or undefined when it isn't resolved there.
const resolvedOutputByCallId = (messages: AI.UIMessage[], toolCallId: string): unknown => {
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolPart(part) && part.toolCallId === toolCallId && part.state === 'output-available') return part.output;
    }
  }
  return undefined;
};

// The tool-part state for a given tool call across a flat message list.
const toolStateByCallId = (messages: AI.UIMessage[], toolCallId: string): string | undefined => {
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolPart(part) && part.toolCallId === toolCallId) return part.state;
    }
  }
  return undefined;
};

// The tool-call ids resolved (output-available) across a flat message list, in
// message/part order — the clean sequence the reconstructed prompt must hold.
const resolvedToolCallIdsInOrder = (messages: AI.UIMessage[]): string[] => {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolPart(part) && part.state === 'output-available') ids.push(part.toolCallId);
    }
  }
  return ids;
};

// The tool-call ids still awaiting a client result (unresolved) across a flat
// message list — expected empty on a clean reconstructed prompt.
const unresolvedToolCallIds = (messages: AI.UIMessage[]): string[] => {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        isToolPart(part) &&
        (part.state === 'input-available' || part.state === 'input-streaming' || part.state === 'approval-requested')
      ) {
        ids.push(part.toolCallId);
      }
    }
  }
  return ids;
};

describe('sequential client tool results across forked reply runs', () => {
  let agent: AgentSessionT | undefined;

  afterEach(async () => {
    await agent?.detach();
    agent = undefined;
    closeAllClients();
  });

  it("carries the prior step's resolved tool call into the next fork's reconstructed agent prompt", async () => {
    const PROMPT_ID = 'user-weather';
    const PROMPT_TEXT = 'What is the weather where I am?';
    const LOC_ASSISTANT_ID = 'asst-location';
    const LOC_TOOL_CALL_ID = 'tc-location';
    const WEATHER_ASSISTANT_ID = 'asst-weather';
    const WEATHER_TOOL_CALL_ID = 'tc-weather';
    const LOCATION = { city: 'Berlin' };
    const WEATHER = { conditions: 'sunny' };

    const { createClientSession } = await import('../../../src/core/transport/client-session.js');
    const channelName = uniqueChannelName('cc-tool-sequential');

    const agentClient = ablyRealtimeClient();
    const tabClient = ablyRealtimeClient({ clientId: 'user-a' });

    agent = createAgentSession({ client: agentClient, channelName, codec: UIMessageCodec });
    await agent.connect();
    const agentSession = agent;

    const tab = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: tabClient,
      channelName,
      codec: UIMessageCodec,
    });
    await tab.connect();

    // Resolve once the run's reconstructed agent prompt satisfies `predicate`,
    // then return that prompt. The fold may land after start()/pipe() resolve,
    // since the agent's own publishes fold back over the channel round-trip.
    const awaitAgentPrompt = async (
      run: OpenableRun<VercelOutput, VercelProjection, AI.UIMessage>,
      predicate: (messages: AI.UIMessage[]) => boolean,
      label: string,
      timeoutMs = 15_000,
    ): Promise<AI.UIMessage[]> => {
      await new Promise<void>((resolve, reject) => {
        if (predicate(flatMessagesOf(run.view))) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          unsubUpdate();
          unsubOutput();
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const onEvent = (): void => {
          if (predicate(flatMessagesOf(run.view))) {
            clearTimeout(timer);
            unsubUpdate();
            unsubOutput();
            resolve();
          }
        };
        const unsubUpdate = agentSession.tree.on('update', onEvent);
        const unsubOutput = agentSession.tree.on('output', onEvent);
      });
      return flatMessagesOf(run.view);
    };

    // Resolve once the tab's VISIBLE branch satisfies `predicate`. The visible
    // branch is the latest reply-run sibling of the prompt, so a freshly-forked
    // run becomes visible here once its run-start folds.
    const awaitClientBranch = async (
      predicate: (messages: AI.UIMessage[]) => boolean,
      label: string,
      timeoutMs = 15_000,
    ): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        if (predicate(flatMessagesOf(tab.view))) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          unsubUpdate();
          unsubOutput();
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const onEvent = (): void => {
          if (predicate(flatMessagesOf(tab.view))) {
            clearTimeout(timer);
            unsubUpdate();
            unsubOutput();
            resolve();
          }
        };
        const unsubUpdate = tab.tree.on('update', onEvent);
        const unsubOutput = tab.tree.on('output', onEvent);
      });
    };

    // Capture each continuation POST's triggering input event so an agent
    // responder can be driven off it (as a real agent server parses the POST
    // body). The POST fires synchronously inside sendMessages, after the channel
    // publish, so the id is present by the time the dispatch resolves.
    const forkInputEventIds: string[] = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- stub returns a resolved Response directly
    const capturingFetch: typeof globalThis.fetch = (_input, requestInit) => {
      const body = requestInit?.body;
      if (typeof body === 'string') {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'inputEventId' in parsed &&
          typeof parsed.inputEventId === 'string'
        ) {
          forkInputEventIds.push(parsed.inputEventId);
        }
      }
      return Promise.resolve(new Response(undefined, { status: 200 }));
    };

    const chat = createChatTransport(tab, { fetch: capturingFetch });

    try {
      // --- Trunk: the tab prompts; the agent streams the FIRST client tool call
      // (getLocation) and SUSPENDS, awaiting a result. ---
      const turn = await tab.view.send(
        UIMessageCodec.createUserMessage({
          id: PROMPT_ID,
          role: 'user',
          parts: [{ type: 'text', text: PROMPT_TEXT }],
        }),
      );
      const trunk = createRunFromOpts(agentSession, { runId: TRUNK_RUN_ID, inputEventId: turn.inputEventId });
      await trunk.start();
      await turn.started;
      await trunk.pipe(clientToolCallStream(LOC_ASSISTANT_ID, 'getLocation', LOC_TOOL_CALL_ID));
      await trunk.suspend();

      await awaitClientBranch(
        (messages) => toolStateByCallId(messages, LOC_TOOL_CALL_ID) === 'input-available',
        'the getLocation call to fold unresolved',
      );

      // --- Step 1: the tab resolves getLocation → forks reply run F1. ---
      await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-seq',
        messageId: undefined,
        messages: [
          { id: PROMPT_ID, role: 'user', parts: [{ type: 'text', text: PROMPT_TEXT }] },
          {
            id: LOC_ASSISTANT_ID,
            role: 'assistant',
            parts: [
              {
                type: 'dynamic-tool',
                toolName: 'getLocation',
                toolCallId: LOC_TOOL_CALL_ID,
                state: 'output-available',
                input: {},
                output: LOCATION,
              },
            ],
          },
        ],
        abortSignal: undefined,
      });
      expect(forkInputEventIds).toHaveLength(1);
      const f1InputEventId = forkInputEventIds[0] ?? '';

      // --- F1's agent responder: driven off F1's own triggering input, it sees
      // the resolved getLocation, streams the SECOND client tool call
      // (getWeather) and SUSPENDS. ---
      const runF1 = createRunFromOpts(agentSession, { runId: crypto.randomUUID(), inputEventId: f1InputEventId });
      await runF1.start();
      while (runF1.view.hasOlder()) await runF1.view.loadOlder();
      const f1Prompt = await awaitAgentPrompt(
        runF1,
        (messages) => resolvedOutputByCallId(messages, LOC_TOOL_CALL_ID) !== undefined,
        "F1's prompt to carry the resolved getLocation",
      );
      // F1's prompt holds exactly the first resolved tool call — no second one yet.
      expect(resolvedToolCallIdsInOrder(f1Prompt)).toEqual([LOC_TOOL_CALL_ID]);
      expect(resolvedOutputByCallId(f1Prompt, LOC_TOOL_CALL_ID)).toEqual(LOCATION);

      await runF1.pipe(clientToolCallStream(WEATHER_ASSISTANT_ID, 'getWeather', WEATHER_TOOL_CALL_ID));
      await runF1.suspend();

      // The tab's visible branch rolls to F1 (the latest sibling): getLocation
      // resolved, getWeather now awaiting a result.
      await awaitClientBranch(
        (messages) =>
          resolvedOutputByCallId(messages, LOC_TOOL_CALL_ID) !== undefined &&
          toolStateByCallId(messages, WEATHER_TOOL_CALL_ID) === 'input-available',
        'the tab branch to roll to F1 with getWeather unresolved',
      );

      // --- Step 2: the tab resolves getWeather → forks reply run F2. The overlay
      // reflects BOTH the first tool resolved AND the second executed, so the
      // fork seed is built from F1's FULL projection. ---
      await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-seq',
        messageId: undefined,
        messages: [
          { id: PROMPT_ID, role: 'user', parts: [{ type: 'text', text: PROMPT_TEXT }] },
          {
            id: LOC_ASSISTANT_ID,
            role: 'assistant',
            parts: [
              {
                type: 'dynamic-tool',
                toolName: 'getLocation',
                toolCallId: LOC_TOOL_CALL_ID,
                state: 'output-available',
                input: {},
                output: LOCATION,
              },
            ],
          },
          {
            id: WEATHER_ASSISTANT_ID,
            role: 'assistant',
            parts: [
              {
                type: 'dynamic-tool',
                toolName: 'getWeather',
                toolCallId: WEATHER_TOOL_CALL_ID,
                state: 'output-available',
                input: {},
                output: WEATHER,
              },
            ],
          },
        ],
        abortSignal: undefined,
      });
      expect(forkInputEventIds).toHaveLength(2);
      const f2InputEventId = forkInputEventIds[1] ?? '';
      expect(f2InputEventId).not.toBe(f1InputEventId);

      // --- F2's agent responder: driven off F2's own triggering input. ---
      const runF2 = createRunFromOpts(agentSession, { runId: crypto.randomUUID(), inputEventId: f2InputEventId });
      await runF2.start();
      while (runF2.view.hasOlder()) await runF2.view.loadOlder();
      const f2Prompt = await awaitAgentPrompt(
        runF2,
        (messages) =>
          resolvedOutputByCallId(messages, LOC_TOOL_CALL_ID) !== undefined &&
          resolvedOutputByCallId(messages, WEATHER_TOOL_CALL_ID) !== undefined,
        "F2's prompt to carry BOTH resolved tool calls",
      );

      // The lock: F2's reconstructed agent prompt carries the WHOLE step sequence
      // — the first tool call resolved AND the second — in order, with nothing
      // left dangling. On a single-message fork seed F2's fork would carry only
      // the second tool call, so getLocation would be ABSENT here (this fails RED).
      expect(runF2.runId).not.toBe(runF1.runId);
      expect(runF2.runId).not.toBe(TRUNK_RUN_ID);
      expect(resolvedToolCallIdsInOrder(f2Prompt)).toEqual([LOC_TOOL_CALL_ID, WEATHER_TOOL_CALL_ID]);
      expect(resolvedOutputByCallId(f2Prompt, LOC_TOOL_CALL_ID)).toEqual(LOCATION);
      expect(resolvedOutputByCallId(f2Prompt, WEATHER_TOOL_CALL_ID)).toEqual(WEATHER);
      expect(unresolvedToolCallIds(f2Prompt)).toEqual([]);

      // The fork responds and ends cleanly, closing out the sequence.
      await runF2.pipe(textResponseStream('asst-final', 'text-final', 'The weather in Berlin is sunny.'));
      await runF2.end({ reason: 'complete' });
    } finally {
      await tab.close();
    }
  }, 60_000);
});
