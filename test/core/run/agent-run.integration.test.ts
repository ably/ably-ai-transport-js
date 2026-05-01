import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRun } from '../../../src/core/run/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import type { ClientView } from '../../../src/core/view/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

/**
 * Reach into the session's private tree for run state. The `tree` accessor
 * is intentionally not on the public session surfaces in phase 7 — it's
 * deferred to a later phase.
 * @param session Any session created via the public factories.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<string> => {
  // CAST: phase 7 keeps `_tree` private; tests reach in via a structural cast
  // to assert decode-loop run state.
  const internals = session as { _tree: Tree<string> };
  return internals._tree;
};

/**
 * Bounded wait for the agent's view to expose the expected number of
 * messages. Resolves immediately if the count is already met.
 * @param run The agent run whose view to observe.
 * @param expected Target message count.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves when the count is met or rejects on timeout.
 */
const waitForRunMessages = async (run: AgentRun<StubCodec>, expected: number, timeoutMs = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (run.view.messages.length >= expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out — run.view.messages.length=${String(run.view.messages.length)}`));
    }, timeoutMs);
    const unsubscribe = run.view.subscribe(() => {
      if (run.view.messages.length >= expected) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });

/**
 * Bounded wait for the client's view to expose the expected message count.
 * Mirrors `waitForRunMessages` but reads from a `ClientView`.
 * @param view The client view to observe.
 * @param expected Target message count.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves when the count is met or rejects on timeout.
 */
const waitForClientMessages = async (
  view: ClientView<StubCodec>,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> =>
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

/**
 * Bounded wait for a run with the given id to reach the supplied status on
 * the session's tree.
 * @param session The session whose tree to observe.
 * @param runId The run id to watch.
 * @param status The status to wait for.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves once the status is observed or rejects on timeout.
 */
const waitForRunStatus = async (
  session: ReturnType<typeof createClientSession<StubCodec>>,
  runId: string,
  status: 'active' | 'complete' | 'failed',
  timeoutMs = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const tree = treeOf(session);
    const matches = (): boolean => tree.runs.find((r) => r.id === runId)?.status === status;
    if (matches()) {
      resolve();
      return;
    }
    const view = session.createView();
    const timer = setTimeout(() => {
      view.close();
      reject(new Error(`timed out waiting for run ${runId} status=${status}; runs=${JSON.stringify(tree.runs)}`));
    }, timeoutMs);
    view.subscribe(() => {
      if (matches()) {
        clearTimeout(timer);
        view.close();
        resolve();
      }
    });
  });

afterEach(() => {
  closeAllClients();
});

/**
 * Phase 7 end-to-end: A's `view.send` opens a run and lands the user
 * message; B subscribes via an `AgentSession`, calls `createRun(invocation)`,
 * reads the user message via `run.view.messages`, then ends the run. A's
 * tree reflects the terminal status.
 *
 * Without phase 13's history hydration, B subscribes before A publishes.
 */
describe('AgentSession.createRun + AgentRun (integration)', () => {
  it('B.createRun → reads A.view.send message → run.end → A.tree.runs reflects complete', async () => {
    const channelName = uniqueChannelName('agent-run');

    // B subscribes first as an agent session.
    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    // A opens a session and sends.
    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();
    const clientRun = await aView.send('hello-from-a');

    // B builds the agent handle from the invocation. Wait for the user
    // message to be visible on B before reading from run.view.
    const invocation = clientRun.toInvocation();
    const bRun = await bSession.createRun(invocation);
    // createRun already waited for the run-start precondition; wait for the
    // user message to be visible on B before reading from run.view.
    await waitForRunMessages(bRun, 1);

    expect(bRun.id).toBe(clientRun.id);
    expect(bRun.view.messages).toHaveLength(1);
    expect(bRun.view.messages[0]?.message).toBe('hello-from-a');
    expect(bRun.messages).toHaveLength(1);
    expect(bRun.initiatorClientId).toBe(aClient.auth.clientId);

    // B ends the run; A observes the terminal status on its tree.
    await bRun.end();
    await waitForRunStatus(aSession, clientRun.id, 'complete');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('complete');

    await aSession.close();
    await bSession.close();
  });

  it('run.end(error) reaches A.tree.runs as failed', async () => {
    const channelName = uniqueChannelName('agent-run-failed');

    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();
    const clientRun = await aView.send('hello');

    const bRun = await bSession.createRun(clientRun.toInvocation());
    await waitForRunMessages(bRun, 1);
    await bRun.end(new Error('agent threw'));

    await waitForRunStatus(aSession, clientRun.id, 'failed');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('failed');

    await aSession.close();
    await bSession.close();
  });

  it('await using on the run dispatches end() at scope exit', async () => {
    const channelName = uniqueChannelName('agent-run-dispose');

    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();
    const clientRun = await aView.send('hello');

    // Also confirm A's view sees the user message before disposal completes,
    // so this test reflects the basic-chat scenario where the agent reads
    // before disposing.
    await waitForClientMessages(aView, 1);

    {
      await using bRun = await bSession.createRun(clientRun.toInvocation());
      await waitForRunMessages(bRun, 1);
      // No explicit end — dispose should publish run-end on scope exit.
    }

    await waitForRunStatus(aSession, clientRun.id, 'complete');

    await aSession.close();
    await bSession.close();
  });
});
