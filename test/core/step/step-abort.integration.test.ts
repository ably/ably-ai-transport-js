import * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { Invocation } from '../../../src/core/invocation/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import type { Tree } from '../../../src/core/tree/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
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
 * End-to-end abort flow against real Ably. Three scenarios:
 *
 *   1. Default flow (developer doesn't wire `step.signal`): client publishes
 *      `x-ably-abort`; agent's pipe consumes the readable to completion;
 *      `run.end()` reads `tree.runs[runId].abortRequested` and publishes
 *      `run-end (aborted)` as confirmation.
 *
 *   2. Pre-existing abort (no agent listening): client publishes the abort
 *      and POSTs the invocation. The agent's `createRun` observes the
 *      abort during precondition resolution and rejects with `RunAborted`.
 *
 *   3. Multi-step run, abort between steps: agent runs step 1; abort
 *      lands; agent's next `step.start()` rejects with `RunAborted`. The
 *      catch path's `run.end(error)` classifies as `'aborted'` because
 *      `step.start` aborted the controller before throwing.
 *
 * Spec: AIT-AB3, AIT-AB4, AIT-AB5, AIT-AB6, AIT-AB7.
 */
describe('x-ably-abort end-to-end (integration)', () => {
  it("default flow: abort during pipe → step completes; run.end() publishes 'aborted'", async () => {
    const channelName = uniqueChannelName('abort-default');

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

    // Client publishes x-ably-abort. The agent observes it; default flow
    // does not interrupt the pipe — the readable still has chunks to push.
    await aClient.channels.get(channelName).publish({
      name: WireMessages.Abort,
      extras: { headers: { [Headers.RunId]: clientRun.id, [Headers.Reason]: 'aborted' } },
    });

    let controller: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;
    const readable = new ReadableStream<AI.UIMessageChunk>({
      start: (c) => {
        controller = c;
      },
    });
    if (!controller) throw new Error('expected stream controller');

    const pipePromise = bStep.pipe(readable);
    controller.enqueue({ type: 'text-start', id: 'agent-text-1' });
    controller.enqueue({ type: 'text-delta', id: 'agent-text-1', delta: 'hello' });
    controller.enqueue({ type: 'text-delta', id: 'agent-text-1', delta: ' world' });
    controller.enqueue({ type: 'text-end', id: 'agent-text-1' });
    controller.close();

    await pipePromise;

    // step.signal aborted (channel observation fired it) but pipe consumed
    // the full readable — that's the AIT-AB6 contract.
    expect(bStep.signal.aborted).toBe(true);

    // Default-flow handler: no error supplied. Step completes; run-end
    // classifier reads abortRequested and publishes 'aborted' confirmation.
    await bStep.end();
    await bRun.end();

    await waitForRunStatus(treeOf(aSession), clientRun.id, 'aborted');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('aborted');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.abortRequested).toBe(true);
    expect(treeOf(aSession).steps.find((s) => s.id === bStep.id)?.status).toBe('complete');

    await aSession.close();
    await bSession.close();
  });

  it('pre-existing abort: createRun rejects with RunAborted (the wire is already terminal)', async () => {
    const channelName = uniqueChannelName('abort-preexisting');

    const aClient = ablyRealtimeClient();
    const aSession = createClientSession({
      client: aClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await aSession.connect();
    const aView = aSession.createView();

    // Open a run, then immediately publish abort. No agent is listening.
    const userMessage: AI.UIMessage = {
      id: 'user-msg',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const clientRun = await aView.send(userMessage);
    await aClient.channels.get(channelName).publish({
      name: WireMessages.Abort,
      extras: { headers: { [Headers.RunId]: clientRun.id, [Headers.Reason]: 'aborted' } },
    });

    await waitForRunStatus(treeOf(aSession), clientRun.id, 'aborted');

    // Now wake an agent. Its createRun should reject because the run is
    // observably aborted by the time preconditions resolve (hydration
    // replay flips the flag).
    const bClient = ablyRealtimeClient();
    const bSession = createAgentSession({
      client: bClient,
      sessionName: channelName,
      codec: UIMessageCodec,
    });
    await bSession.connect();

    await expect(
      bSession.createRun(Invocation.fromJSON(clientRun.toInvocation().toJSON())),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.RunAborted);

    // Tree-level confirmation: synthesised status remains 'aborted'.
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('aborted');

    await aSession.close();
    await bSession.close();
  });

  it("multi-step run: abort between steps rejects step.start(); run.end(error) publishes 'aborted'", async () => {
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

    // Abort lands between steps.
    await aClient.channels.get(channelName).publish({
      name: WireMessages.Abort,
      extras: { headers: { [Headers.RunId]: clientRun.id, [Headers.Reason]: 'aborted' } },
    });
    await waitForRunStatus(treeOf(bSession), clientRun.id, 'aborted');

    // Step 2 attempts to start — must reject with RunAborted.
    const step2 = bRun.createStep();
    let stepStartError: unknown;
    try {
      await step2.start();
    } catch (error) {
      stepStartError = error;
    }
    expect(stepStartError).toBeInstanceOf(Ably.ErrorInfo);
    expect((stepStartError as Ably.ErrorInfo).code).toBe(ErrorCode.RunAborted);

    // Handler's run.end(error). The classifier recognises the
    // SDK-thrown RunAborted error as signal-driven and routes to
    // 'aborted' (alongside the abortRequested observation).
    await bRun.end(stepStartError);

    // Confirmation publish lands on the channel; tree status stays 'aborted'.
    await waitForRunStatus(treeOf(aSession), clientRun.id, 'aborted');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('aborted');

    await aSession.close();
    await bSession.close();
  });
});
