import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Run } from '../../../src/core/run/index.js';
import { createClientRun } from '../../../src/core/run/index.js';
import { createClientSession } from '../../../src/core/session/index.js';
import type { DefaultSessionWriter } from '../../../src/core/session/writer.js';
import type { Tree } from '../../../src/core/tree/index.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
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
      controlSignals: [],
      pauseRequested: false,
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

  it('multi-device idempotence: second client.abort() is a no-op once the abort is observed', async () => {
    // Spec: AIT-AB3. Two clients on the same channel. Client A calls
    // run.abort(); the wire records one x-ably-abort. Client B observes
    // the abort via its channel subscription; B's run.abort() is a no-op.
    const channelName = uniqueChannelName('run-abort-idempotence');

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    const bClient = ablyRealtimeClient();
    const bSession = createClientSession({
      client: bClient,
      sessionName: channelName,
      codec: stubCodec,
    });
    await bSession.connect();

    const aRun = await aView.send('hello');
    await waitForRuns(bSession, (runs) => runs.length === 1 && runs[0]?.status === 'active');

    // Client A publishes the abort. Both clients observe it.
    await aRun.abort();
    await waitForRuns(bSession, (runs) => runs[0]?.status === 'aborted');

    // Construct a B-side ClientRun handle bound to the same runId. (Real
    // apps would obtain this via a future `view.runs` surface; this test
    // reaches in to assert ClientRun.abort's idempotence directly.)
    // CAST: integration tests reach into session internals to assemble a
    // ClientRun without re-publishing run-start.
    const bInternals = bSession as unknown as {
      _writer: DefaultSessionWriter<StubCodec>;
      _tree: Tree<string>;
    };
    const bChannel = bClient.channels.get(channelName);
    const bPublishSpy = vi.spyOn(bChannel, 'publish');
    const bRun = createClientRun<StubCodec>({
      id: aRun.id,
      status: 'active',
      initiatorClientId: aClient.auth.clientId,
      sessionName: channelName,
      tree: bInternals._tree,
      writer: bInternals._writer,
      logger: makeLogger({ logLevel: LogLevel.Silent }),
    });

    await bRun.abort();

    // The run was already terminal in B's tree (synthesised aborted from
    // the observed x-ably-abort), so abort() short-circuits without
    // touching the channel.
    expect(bPublishSpy).not.toHaveBeenCalled();

    await aSession.close();
    await bSession.close();
  });
});
