import { afterEach, describe, expect, it } from 'vitest';

import type { Run } from '../../../src/core/run/index.js';
import { createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

/**
 * Reach into the session's private tree for run state. The `tree` accessor
 * is intentionally not on the public session surfaces in phase 5 — it's
 * deferred to a later phase.
 * @param session The session under test.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<string> => {
  // CAST: phase 5 keeps `_tree` private; tests reach in via a structural cast
  // to assert decode-loop run state. The accessor will become public later.
  const internals = session as { _tree: Tree<string> };
  return internals._tree;
};

/**
 * Bounded wait until a predicate over the session's runs holds, polling via
 * the session's own view (a coarse `subscribe` notification fires for every
 * tree change). Resolves immediately if the predicate already holds.
 * @param session The session whose tree to observe.
 * @param predicate Returns true once the runs collection matches the test's expectation.
 * @param timeoutMs Max wait in ms.
 * @returns A promise that resolves once the predicate holds, or rejects on timeout.
 */
const waitForRuns = async (
  session: ReturnType<typeof createClientSession<StubCodec>>,
  predicate: (runs: readonly Run<string>[]) => boolean,
  timeoutMs = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const tree = treeOf(session);
    if (predicate(tree.runs)) {
      resolve();
      return;
    }
    const view = session.createView();
    const timer = setTimeout(() => {
      view.close();
      reject(new Error(`timed out — runs=${JSON.stringify(tree.runs)}`));
    }, timeoutMs);
    view.subscribe(() => {
      if (predicate(tree.runs)) {
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
 * Phase 5 end-to-end: B subscribes; A publishes a hand-crafted
 * `x-ably-run-start` (the only producer until phase 6's `view.send`); A
 * then calls `writer.endRun`; B's `tree.runs` reflects both transitions.
 *
 * Without phase 13's history hydration, B must subscribe before A publishes
 * — late subscribers miss earlier publishes.
 */
describe('Run lifecycle (integration)', () => {
  it('A.run-start then A.endRun lands on B.tree.runs as active → complete', async () => {
    const channelName = uniqueChannelName('run-lifecycle');

    // B subscribes first.
    const bClient = ablyRealtimeClient();
    const bSession = createClientSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    // A publishes a hand-crafted run-start, then ends the run via the writer.
    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();

    const aChannel = aClient.channels.get(channelName);
    await aChannel.publish({
      name: WireMessages.RunStart,
      extras: {
        headers: { [Headers.RunId]: 'r-1' },
      },
    });

    await waitForRuns(bSession, (runs) => runs.length === 1 && runs[0]?.status === 'active');
    expect(treeOf(bSession).runs[0]).toEqual<Run<string>>({
      id: 'r-1',
      status: 'active',
      initiatorClientId: aClient.auth.clientId,
    });

    await aSession.writer.endRun({ runId: 'r-1', status: 'complete' });

    await waitForRuns(bSession, (runs) => runs[0]?.status === 'complete');
    expect(treeOf(bSession).runs[0]?.status).toBe('complete');

    await aSession.close();
    await bSession.close();
  });

  it('honours an x-ably-client-id override on the run-start', async () => {
    const channelName = uniqueChannelName('run-initiator-override');

    const bClient = ablyRealtimeClient();
    const bSession = createClientSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    const aClient = ablyRealtimeClient();
    await aClient.connection.once('connected');
    const aChannel = aClient.channels.get(channelName);
    await aChannel.publish({
      name: WireMessages.RunStart,
      extras: {
        headers: {
          [Headers.RunId]: 'r-1',
          [Headers.ClientId]: 'end-user-1',
        },
      },
    });

    await waitForRuns(bSession, (runs) => runs.length === 1);
    expect(treeOf(bSession).runs[0]?.initiatorClientId).toBe('end-user-1');

    await bSession.close();
  });
});
