import { afterEach, describe, expect, it } from 'vitest';

import type { Run } from '../../../src/core/run/index.js';
import { createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import type { ClientView } from '../../../src/core/view/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

/**
 * Reach into the session's private tree for run state. The `tree` accessor
 * is intentionally not on the public session surface in phase 6 — it's
 * deferred to a later phase.
 * @param session Any session created via the public factories.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<string> => {
  // CAST: phase 6 keeps `_tree` private; tests reach in via a structural cast
  // to assert decode-loop run state. The accessor will become public later.
  const internals = session as { _tree: Tree<string> };
  return internals._tree;
};

/**
 * Bounded wait until the view's messages reach the expected count, polling
 * via the view's own subscribe. Resolves immediately if the count is
 * already met.
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

const hasRun = (runs: readonly Run<string>[], runId: string): boolean => runs.some((r) => r.id === runId);

/**
 * Bounded wait for a run with the given id to be present in the session's
 * tree. Resolves immediately if it's already there.
 * @param session The session whose tree to observe.
 * @param runId The run id to wait for.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves once the run is visible or rejects on timeout.
 */
const waitForRun = async (
  session: ReturnType<typeof createClientSession<StubCodec>>,
  runId: string,
  timeoutMs = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const tree = treeOf(session);
    if (hasRun(tree.runs, runId)) {
      resolve();
      return;
    }
    const view = session.createView();
    const timer = setTimeout(() => {
      view.close();
      reject(new Error(`timed out waiting for run ${runId} — runs=${JSON.stringify(tree.runs)}`));
    }, timeoutMs);
    view.subscribe(() => {
      if (hasRun(tree.runs, runId)) {
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
 * Phase 6 end-to-end milestone #2: A's `view.send` opens a run and lands
 * the user message; B observes both the run and the message via its own
 * session view. Without phase 13's history hydration, B subscribes first.
 */
describe('ClientView.send (integration)', () => {
  it('A.view.send → B sees the user message and the active run', async () => {
    const channelName = uniqueChannelName('view-send');

    // B subscribes first.
    const bClient = ablyRealtimeClient();
    const bSession = createClientSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();
    const bView = bSession.createView();

    // A opens a session and sends.
    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    const aRun = await aView.send('hello-from-a');

    // The returned run is local snapshot — its initiatorClientId reflects
    // the publishing connection's clientId.
    expect(aRun.status).toBe('active');
    expect(aRun.initiatorClientId).toBe(aClient.auth.clientId);

    // B observes the message and the run.
    await waitForMessages(bView, 1);
    await waitForRun(bSession, aRun.id);

    expect(bView.messages).toHaveLength(1);
    expect(bView.messages[0]?.message).toBe('hello-from-a');
    expect(bView.messages[0]?.role).toBe('user');
    expect(bView.messages[0]?.clientId).toBe(aClient.auth.clientId);

    const bRuns = treeOf(bSession).runs;
    expect(bRuns).toHaveLength(1);
    expect(bRuns[0]?.id).toBe(aRun.id);
    expect(bRuns[0]?.status).toBe('active');
    expect(bRuns[0]?.initiatorClientId).toBe(aClient.auth.clientId);

    await aSession.close();
    await bSession.close();
  });

  it("the run's invocation round-trips and matches the published message id", async () => {
    const channelName = uniqueChannelName('view-send-invocation');

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
    const aView = aSession.createView();

    const run = await aView.send('hi');
    const invocation = run.toInvocation().toJSON();

    expect(invocation.sessionName).toBe(channelName);
    expect(invocation.runId).toBe(run.id);

    await waitForMessages(bView, 1);
    expect(bView.messages[0]?.id).toBe(invocation.messageId);

    await aSession.close();
    await bSession.close();
  });
});
