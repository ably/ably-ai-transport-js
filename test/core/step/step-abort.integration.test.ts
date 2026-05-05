import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { Invocation } from '../../../src/core/invocation/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

/**
 * Reach into a session's private tree for tests that need to inspect run
 * and step state.
 * @param session Any session created via the public factories.
 * @returns The session's internal tree.
 */
const treeOf = (session: object): Tree<AI.UIMessage> => {
  // CAST: phase 11 keeps `_tree` private; tests reach in via a structural
  // cast to assert decode-loop run/step state.
  const internals = session as { _tree: Tree<AI.UIMessage> };
  return internals._tree;
};

/**
 * Bounded wait for a run on the supplied tree to reach the given status.
 * @param tree The tree to observe.
 * @param runId The run id to watch.
 * @param status The status to wait for.
 * @param timeoutMs Max wait in ms.
 * @returns Resolves once the run reaches the status; rejects on timeout.
 */
const waitForRunStatus = async (
  tree: Tree<AI.UIMessage>,
  runId: string,
  status: 'active' | 'complete' | 'failed' | 'aborted',
  timeoutMs = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const matches = (): boolean => tree.runs.find((r) => r.id === runId)?.status === status;
    if (matches()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for run ${runId} status=${status}; runs=${JSON.stringify(tree.runs)}`));
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
 * End-to-end abort flow against real Ably under the symmetric model:
 *
 *   1. Abort during pipe — client publishes `x-ably-abort`; agent's
 *      step.signal fires from the channel observation; the pipe still
 *      consumes the readable (the developer chose not to interrupt);
 *      the agent's catch path with an AbortError calls `run.end(err)`,
 *      which classifies as `'aborted'`.
 *
 *   2. Pre-existing abort (no agent listening) — the client publishes
 *      the abort and the agent's `createRun` resolves anyway. The
 *      agent processes the signal during its step and produces the
 *      run-end that actually transitions the run to `'aborted'`.
 *
 *   3. Multi-step run, abort between steps — agent runs step 1, abort
 *      lands, agent starts step 2 successfully; step 2's signal fires
 *      from the channel observation and the catch path classifies the
 *      AbortError throw as `'aborted'`.
 */
describe('x-ably-abort end-to-end (integration)', () => {
  it("abort observed during step → catch path with AbortError publishes run-end 'aborted'", async () => {
    const channelName = uniqueChannelName('abort-during-step');

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await bSession.connect();

    const userMessage: AI.UIMessage = {
      id: 'user-msg',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const clientRun = await aView.send(userMessage);

    const bRun = await bSession.createRun(Invocation.fromJSON(clientRun.toInvocation().toJSON()));
    const bStep = bRun.createStep();
    await bStep.start();

    // Client publishes x-ably-abort using the writer (which stamps
    // x-ably-msg-id) — the agent's step.signal fires from the
    // observation.
    await aSession.writer.abort({ runId: clientRun.id });

    // Wait for the abort signal to reach the agent's step.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for step.signal'));
      }, 10_000);
      if (bStep.signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      bStep.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    // Agent's catch path: simulate the model SDK throwing AbortError
    // when its abortSignal (wired to step.signal) fires.
    const abortError = new DOMException('aborted', 'AbortError');
    await bStep.end(abortError);
    await bRun.end(abortError);

    await waitForRunStatus(treeOf(aSession), clientRun.id, 'aborted');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('aborted');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.controlSignals.length).toBe(1);

    await aSession.close();
    await bSession.close();
  });

  it("pre-existing abort: createRun resolves; signal is recorded on the run's controlSignals", async () => {
    const channelName = uniqueChannelName('abort-preexisting');

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    const userMessage: AI.UIMessage = {
      id: 'user-msg',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const clientRun = await aView.send(userMessage);
    await aSession.writer.abort({ runId: clientRun.id });

    // Bring up a fresh agent — under the symmetric model, createRun
    // resolves regardless of prior abort. The agent inspects the run's
    // controlSignals to decide what to do.
    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await bSession.connect();

    const bRun = await bSession.createRun(Invocation.fromJSON(clientRun.toInvocation().toJSON()));
    expect(bRun.controlSignals.some((s) => s.type === 'abort')).toBe(true);
    expect(bRun.status).toBe('active');

    await aSession.close();
    await bSession.close();
  });

  it('multi-step: abort between steps; step 2 starts and observes the abort during its lifetime', async () => {
    const channelName = uniqueChannelName('abort-between-steps');

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await bSession.connect();

    const userMessage: AI.UIMessage = {
      id: 'user-msg',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const clientRun = await aView.send(userMessage);

    const bRun = await bSession.createRun(Invocation.fromJSON(clientRun.toInvocation().toJSON()));

    // Step 1 runs to completion.
    {
      const step = bRun.createStep();
      await step.start();
      await step.end();
    }

    // Abort lands between steps. Symmetric model: step.start in step 2
    // proceeds; the abort fires step.signal as soon as step 2 mounts
    // its control-signal subscription.
    await aSession.writer.abort({ runId: clientRun.id });

    const step2 = bRun.createStep();
    await step2.start();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for step.signal'));
      }, 10_000);
      if (step2.signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      step2.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    const abortError = new DOMException('aborted', 'AbortError');
    await step2.end(abortError);
    await bRun.end(abortError);

    await waitForRunStatus(treeOf(aSession), clientRun.id, 'aborted');

    await aSession.close();
    await bSession.close();
  });
});
