import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { stubCodec } from '../../helper/stub-codec.js';

/**
 * Reach into a session's private tree for tests that need to inspect step
 * state. The `tree` accessor is intentionally not on the public session
 * surfaces in phase 9 — it's deferred to a later phase.
 * @param session Any session created via the public factories.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<string> => {
  // CAST: phase 9 keeps `_tree` private; tests reach in via a structural cast
  // to assert decode-loop step state.
  const internals = session as { _tree: Tree<string> };
  return internals._tree;
};

/**
 * Bounded wait until the supplied tree exposes a step with the given id.
 * @param tree The tree to observe.
 * @param stepId The step id to wait for.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves once the step is recorded or rejects on timeout.
 */
const waitForStep = async (tree: Tree<string>, stepId: string, timeoutMs = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const matches = (): boolean => tree.steps.some((s) => s.id === stepId);
    if (matches()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for step ${stepId}; steps=${JSON.stringify(tree.steps)}`));
    }, timeoutMs);
    const unsubscribe = tree.subscribe(() => {
      if (matches()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });

afterEach(() => {
  closeAllClients();
});

/**
 * Phase 9 end-to-end: B's `run.createStep().start()` lands an
 * `x-ably-step-start` on the channel; A's tree (subscribed first) observes
 * the step as `'active'`.
 *
 * Without phase 13's history hydration, A subscribes first.
 *
 * Note: phase 9 does not implement step-end. The step stays `'active'` on
 * the channel until phase 10 ships `step.end`. Each test uses a unique
 * channel name so this leak is bounded.
 */
describe('AgentRun.createStep + Step.start (integration)', () => {
  it("B.run.createStep().start() → A's tree observes the step as active", async () => {
    const channelName = uniqueChannelName('step-start');

    // A subscribes first as a client session and reads the tree directly.
    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    // B opens an agent session, opens a run via A's view.send, then runs a step.
    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    const clientRun = await aView.send('hello');
    const bRun = await bSession.createRun(clientRun.toInvocation());
    const step = bRun.createStep();
    await step.start();

    // Step.start() resolves once the publish has come back through B's own
    // decode loop; A still needs to observe the step on its tree.
    await waitForStep(treeOf(aSession), step.id);

    expect(treeOf(aSession).steps).toEqual([{ id: step.id, runId: clientRun.id, status: 'active' }]);
    expect(step.status).toBe('active');

    await aSession.close();
    await bSession.close();
  });
});
