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
 * Bounded wait for a step on the supplied tree to reach the given status.
 * @param tree The tree to observe.
 * @param stepId The step id to watch.
 * @param status The status to wait for.
 * @param timeoutMs Max wait in ms.
 * @returns Resolves once the step reaches the status; rejects on timeout.
 */
const waitForStepStatus = async (
  tree: Tree<AI.UIMessage>,
  stepId: string,
  status: 'active' | 'complete' | 'failed' | 'aborted',
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
 * Bounded wait for a run on the supplied tree to reach the given terminal
 * status.
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
 * Phase 11 end-to-end: B opens a step with a caller-supplied signal,
 * pipes a slow stream, B aborts mid-pipe, B's pipe exits cleanly, B
 * calls `step.end(error)` (publishes 'failed') and `run.end(error)`
 * (publishes 'aborted' via the abort row of the classifier reading
 * `step.signal.reason === ABORTED`). A's tree reflects both terminals.
 */
describe('Step.signal abort + AgentRun.end abort row (integration)', () => {
  it("caller-signal abort during pipe → step ends 'failed', run ends 'aborted'", async () => {
    const channelName = uniqueChannelName('step-abort');

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

    // Open a run with a user message.
    const userMessage: AI.UIMessage = {
      id: 'user-msg',
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    };
    const clientRun = await aView.send(userMessage);

    // B binds the agent run and opens a step under a caller signal.
    const bRun = bSession.createRun(Invocation.fromJSON(clientRun.toInvocation().toJSON()));
    const bStep = bRun.createStep();
    const ac = new AbortController();
    await bStep.start({ signal: ac.signal });

    // Slow stream: enqueue one chunk, abort, then close. The pipe loop
    // encodes the first chunk, sees the abort on the next iteration, and
    // exits without encoding anything else.
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
    // The producer immediately follows up with a delta — abort the
    // caller signal once we've enqueued the early chunks but before the
    // *-end. The pipe loop's signal check exits the loop without
    // encoding any further chunks the producer might enqueue.
    setTimeout(() => {
      ac.abort();
      controller?.enqueue({ type: 'text-delta', id: 'agent-text-1', delta: ' world' });
      controller?.enqueue({ type: 'text-end', id: 'agent-text-1' });
      controller?.close();
    }, 100);

    await pipePromise;

    expect(bStep.signal.aborted).toBe(true);

    // Caller-emulated catch block from the basic-chat workflow:
    //   step.end(error); run.end(error);
    const error = new Error('agent hop aborted by caller signal');
    await bStep.end(error);
    await bRun.end(error);

    await waitForStepStatus(treeOf(aSession), bStep.id, 'failed');
    await waitForRunStatus(treeOf(aSession), clientRun.id, 'aborted');

    expect(treeOf(aSession).steps.find((s) => s.id === bStep.id)?.status).toBe('failed');
    expect(treeOf(aSession).runs.find((r) => r.id === clientRun.id)?.status).toBe('aborted');

    await aSession.close();
    await bSession.close();
  });
});
