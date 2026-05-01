import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { Invocation } from '../../../src/core/invocation/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import type { ClientView } from '../../../src/core/view/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

/**
 * Reach into a session's private tree for tests that need to inspect step
 * state.
 * @param session Any session created via the public factories.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<AI.UIMessage> => {
  // CAST: phase 10 keeps `_tree` private; tests reach in via a structural cast
  // to assert decode-loop step state.
  const internals = session as { _tree: Tree<AI.UIMessage> };
  return internals._tree;
};

/**
 * Bounded wait until the supplied tree reports a step matching the given id
 * with the supplied status.
 * @param tree The tree to observe.
 * @param stepId The step id to watch.
 * @param status The status to wait for.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves once the step reaches the status, or rejects on timeout.
 */
const waitForStepStatus = async (
  tree: Tree<AI.UIMessage>,
  stepId: string,
  status: 'active' | 'complete' | 'failed',
  timeoutMs = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const matches = (): boolean => tree.steps.find((s) => s.id === stepId)?.status === status;
    if (matches()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for step ${stepId} status=${status}; steps=${JSON.stringify(tree.steps)}`));
    }, timeoutMs);
    const unsubscribe = tree.subscribe(() => {
      if (matches()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });

/**
 * Bounded wait for a UIMessage with non-empty text parts to appear on the
 * supplied client view.
 * @param view The client view to observe.
 * @param predicate Predicate run on each candidate message.
 * @param timeoutMs Max wait in ms.
 * @returns The first matching UIMessage, or rejects on timeout.
 */
const waitForMessage = async (
  view: ClientView<typeof UIMessageCodec>,
  predicate: (message: AI.UIMessage) => boolean,
  timeoutMs = 10_000,
): Promise<AI.UIMessage> =>
  new Promise<AI.UIMessage>((resolve, reject) => {
    const find = (): AI.UIMessage | undefined => view.messages.find((node) => predicate(node.message))?.message;
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

/**
 * Phase 10 end-to-end milestone #3 (agent streaming): B pipes a fixture
 * stream of `UIMessageChunk` through `step.pipe`; A's accumulator
 * assembles the resulting `UIMessage` and A's tree records the step as
 * `'complete'` once `step.end()` lands.
 */
describe('Step.pipe + Step.end with UIMessageCodec (integration)', () => {
  it('B.step.pipe(fixture chunks) → A reads assembled UIMessage + step transitions to complete', async () => {
    const channelName = uniqueChannelName('step-pipe');

    // A subscribes first as the client and reads the assembled message + tree.
    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    // B opens an agent session, opens a run via A's view.send, then runs a step.
    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await bSession.connect();

    // Drive A.view.send to land a user message and open the run.
    const userMessage: AI.UIMessage = {
      id: 'user-msg',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const clientRun = await aView.send(userMessage);
    const invocation = clientRun.toInvocation();

    // B binds the agent run and starts a step.
    const bRun = await bSession.createRun(Invocation.fromJSON(invocation.toJSON()));
    const bStep = bRun.createStep();
    await bStep.start();

    // Fixture chunk stream the codec covers in phase 8: text-start, deltas, text-end.
    const chunkStream = new ReadableStream<AI.UIMessageChunk>({
      start: (controller) => {
        controller.enqueue({ type: 'text-start', id: 'agent-text-1' });
        controller.enqueue({ type: 'text-delta', id: 'agent-text-1', delta: 'hello' });
        controller.enqueue({ type: 'text-delta', id: 'agent-text-1', delta: ' ' });
        controller.enqueue({ type: 'text-delta', id: 'agent-text-1', delta: 'world' });
        controller.enqueue({ type: 'text-end', id: 'agent-text-1' });
        controller.close();
      },
    });
    await bStep.pipe(chunkStream);
    await bStep.end();

    // A's tree records the step as complete; A's view assembles the UIMessage.
    await waitForStepStatus(treeOf(aSession), bStep.id, 'complete');
    const assembled = await waitForMessage(
      aView,
      (m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text === 'hello world'),
    );

    expect(assembled.role).toBe('assistant');
    const textParts = assembled.parts.filter((p) => p.type === 'text');
    expect(textParts).toHaveLength(1);
    const firstPart = textParts[0];
    if (firstPart?.type !== 'text') throw new Error('expected text part');
    expect(firstPart.text).toBe('hello world');

    expect(treeOf(aSession).steps.find((s) => s.id === bStep.id)?.status).toBe('complete');

    await aSession.close();
    await bSession.close();
  });
});
