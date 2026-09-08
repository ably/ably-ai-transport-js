/**
 * Temporal integration tests over real Ably.
 *
 * Every test here has three jobs, and they matter equally.
 *
 * 1. **Exercise the public API.** A test calls only what an application can
 *    call: what an `index.ts` re-exports. It never reaches into a transport's
 *    fields or asserts on private state.
 * 2. **Demonstrate use.** A test reads as the code a developer would write to
 *    get the behaviour, in the order they would write it. Both sides are
 *    written out: the browser publishes its input through a `ClientTransport`,
 *    and the agent's HTTP route starts a workflow for the invocation the
 *    browser published. Compare `demo/temporal/temporal-agent` — the route at
 *    `src/app/api/chat/route.ts` and the worker at `src/worker/index.ts` do
 *    exactly what the bodies below do.
 * 3. **Verify the behaviour.** A test fails when the behaviour breaks, and its
 *    assertions read delivered events off the channel, which is what a browser
 *    sees.
 *
 * Nothing is mocked. A real Temporal server runs real fixture workflows through
 * the real `createAblyTransportPlugin`, whose activities build real Ably clients
 * and publish to a real channel.
 *
 * That combination is the point. The unit tier mocks `createAgentTransport`, so
 * `run.opened` is a resolved promise and no client is ever built; the Temporal
 * tier fakes the framing activities, so no channel is touched. Between them the
 * claims that matter to a durable agent go unverified: that a retry re-enters
 * the same run rather than forking it, that a run one activity leaves open is
 * still there for the next, and that a retried step supersedes its dead
 * attempt's output on the wire. Each needs a real Temporal retry and real Ably
 * append semantics at the same time.
 *
 * `createLocal()` rather than `createTimeSkipping()`: these activities do real
 * network I/O, and a server free to fast-forward its clock while that happens
 * could fire `startToCloseTimeout` mid-request. Temporal recommends the local
 * server for general workflow testing, and it needs no Rosetta on ARM. The cost
 * is that a `sleep()` in a fixture really sleeps, so no fixture waits one out.
 *
 * One server, one webpack bundle and one long-lived worker serve the whole file
 * — the worker is the agent's deployment, stood up once. `worker.runUntil` is
 * deliberately not used per test: it shuts the worker down, and a shutdown
 * cancels in-flight activities, which with real Ably clients inside them turns
 * ordinary teardown into aborted connects.
 *
 * The plugin is codec-agnostic, and the codec here is a minimal one built for
 * this suite (`./test-codec.ts`): a prompt in, a text stream out. A provider's
 * codec would put that provider's vocabulary on screen, and none of it would say
 * anything about Temporal.
 */

import '../../helper/expectations.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { channelAgent } from '../../../src/core/agent.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { InvocationData } from '../../../src/core/transport/invocation.js';
import type { TransportEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { createAblyTransportPlugin } from '../../../src/temporal/plugin.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createEventRecorder } from '../helpers.js';
import * as appActivities from './activities.js';
import { DEAD_ATTEMPT_TEXT } from './activities.js';
import type { TextChunk, UserPrompt } from './test-codec.js';
import { assembleText, createTestCodec } from './test-codec.js';
import type { FixtureInput } from './workflows/fixtures.js';

const codec = createTestCodec();
const workflowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'workflows/fixtures.ts');
const TASK_QUEUE = 'ai-transport-integration';

/** The prompt every test's browser sends. */
const prompt: UserPrompt = { kind: 'user-prompt', payload: { text: 'hello agent' } };

/** The text stream id every fixture answers under. */
const REPLY_ID = 'a1';

type Event = TransportEvent<UserPrompt, TextChunk>;

/**
 * The run and step lifecycle a browser saw, in delivery order, with the
 * codec's own messages left out. Every test asserts the whole bracket, so the
 * plugin's activities and the step helper are checked together.
 * @param events - Everything the recorder saw.
 * @returns The lifecycle events only.
 */
const lifecycleOf = (events: readonly Event[]): Event[] =>
  events.filter((event) => event.kind === 'run-lifecycle' || event.kind === 'step-lifecycle');

/**
 * Whether the recorder has seen both a step end and the run's end.
 * @param events - Everything the recorder saw.
 * @returns True once both ends have been delivered.
 */
const stepAndRunEnded = (events: readonly Event[]): boolean =>
  events.some((event) => event.kind === 'step-lifecycle' && event.event.type === 'step-end') &&
  events.some((event) => event.kind === 'run-lifecycle' && event.event.type === 'end');

let env: TestWorkflowEnvironment;
let worker: Worker;
/** The worker's own run promise, awaited at teardown so shutdown completes. */
let workerRunning: Promise<void>;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  // Bundled once for the file. The Temporal tier pays this per test because
  // each test registers different fakes; here every test wants the same plugin.
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities: appActivities,
    plugins: [
      createAblyTransportPlugin({
        codec,
        // The framing activities run in this process, so the clients they build
        // land in the same registry `closeAllClients()` drains.
        createClient: () => ablyRealtimeClient(),
      }),
    ],
  });
  workerRunning = worker.run();
  // A cold cache downloads the Temporal CLI, then boots a server and runs
  // webpack, none of which fits vitest's 10s hook default.
}, 120_000);

afterAll(async () => {
  worker.shutdown();
  await workerRunning;
  await env.teardown();
});

afterEach(() => {
  closeAllClients();
});

describe('durable runs over a real channel', () => {
  it('opens, answers and ends a run pinned to the invocation id', async () => {
    const channelName = uniqueChannelName('tmp-run');

    // ---- the browser -------------------------------------------------------
    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    // ---- the agent's POST handler ------------------------------------------
    // It mints an invocation id, points a workflow at the input the browser
    // just published, and answers. It publishes nothing itself.
    const invocationId = crypto.randomUUID();
    const invocation: InvocationData = { channelName, inputEventId: sent.eventId };
    const args: [FixtureInput] = [{ invocation, invocationId, reply: 'Hello human' }];
    const handle = await env.client.workflow.start('durableRun', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });

    // ---- back in the browser, which learns everything from the channel -----
    // The workflow has to settle before this test returns. The suite shares one
    // worker, so an activity still running would have its Ably client closed
    // under it by `afterEach`.
    await handle.result();
    await received.waitForEvent((event) => event.kind === 'run-lifecycle' && event.event.type === 'end');

    // This is the baseline the other tests lean on, so it checks the whole
    // bracket: the plugin opens the run, the answering activity's one step
    // starts and ends inside it, and the run ends. The run id is the
    // invocation id the route minted, so a retry of the plugin's openRun
    // re-enters this run instead of opening a second one. The step ends
    // `complete` before the run does, because ending the run inside the step
    // helper's body closes the open step first.
    expect(lifecycleOf(received.events)).toMatchObject([
      {
        kind: 'run-lifecycle',
        event: { type: 'start', runId: invocationId, inputTransportMessageId: sent.transportMessageId },
      },
      { kind: 'step-lifecycle', event: { type: 'step-start', runId: invocationId, invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-end', runId: invocationId, reason: 'complete' } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId, reason: 'complete' } },
    ]);

    // The codec carries the stream id as a header, and the decoder puts it back
    // on every output it rebuilds.
    const outputs = received.events.flatMap((event) => (event.kind === 'message' ? event.outputs : []));
    expect(outputs.map((output) => output.id)).toEqual([REPLY_ID, REPLY_ID, REPLY_ID, REPLY_ID]);
    expect(assembleText(outputs)).toBe('Hello human');

    // The browser's own publish comes back as an ordinary delivery, and decodes
    // to what it sent.
    const inputs = received.events.flatMap((event) => (event.kind === 'message' ? event.inputs : []));
    expect(inputs).toEqual([prompt]);

    client.close();
  });

  it('ends the run from workflow code, across three processes and three connections', async () => {
    // openRun, answerStep and endRun each build their own client and
    // connection. Between them the run stays open on the wire, because closing
    // a transport publishes no terminal.
    const channelName = uniqueChannelName('tmp-endwf');

    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    const invocationId = crypto.randomUUID();
    const args: [FixtureInput] = [
      { invocation: { channelName, inputEventId: sent.eventId }, invocationId, reply: 'ended from above' },
    ];
    const handle = await env.client.workflow.start('endsFromWorkflow', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });

    await handle.result();
    await received.waitForEvent((event) => event.kind === 'run-lifecycle' && event.event.type === 'end');

    // The same bracket as the first test, produced by three processes. The
    // step ends `complete` from inside the answering activity, and the run's
    // terminal references the runId the plugin's openRun opened with reason
    // `complete`, which only endRun publishes. The cleanup arm would have
    // published `error`.
    expect(lifecycleOf(received.events)).toMatchObject([
      { kind: 'run-lifecycle', event: { type: 'start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-end', runId: invocationId, reason: 'complete' } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId, reason: 'complete' } },
    ]);
    expect(assembleText(received.events.flatMap((event) => (event.kind === 'message' ? event.outputs : [])))).toBe(
      'ended from above',
    );

    client.close();
  });

  it('supersedes a dead attempt when Temporal retries the answering activity', async () => {
    const channelName = uniqueChannelName('tmp-retry');

    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    // `failFirstAttempt` is what drives the retry, and it is the only thing
    // that differs from the first test. `answerStep` in ./activities.ts reads
    // it: on `Context.current().info.attempt === 1` it publishes
    // DEAD_ATTEMPT_TEXT and throws, and `withStep` ends the step `failed`. The
    // fixture's `answerStep` proxy allows two attempts, so Temporal runs it
    // again — and a retry keeps the same `activityId`, which `withStep` keys
    // its step on, so both attempts share one `stepId`.
    const invocationId = crypto.randomUUID();
    const args: [FixtureInput] = [
      {
        invocation: { channelName, inputEventId: sent.eventId },
        invocationId,
        reply: 'the complete answer',
        failFirstAttempt: true,
      },
    ];
    const handle = await env.client.workflow.start('durableRun', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });

    await handle.result();
    await received.waitForEvent((event) => event.kind === 'run-lifecycle' && event.event.type === 'end');

    // One run, two step attempts under one step id. The dead attempt's step
    // ends `failed` when the activity throws, the retry's step starts under
    // the same id and ends `complete`, and each end references its own
    // start's serial. The retry's start carries the larger serial, and that
    // ordering is the supersede rule itself: a reader takes the largest serial
    // for a step id, so the retry's output is the one that counts.
    const lifecycle = lifecycleOf(received.events);
    expect(lifecycle).toMatchObject([
      { kind: 'run-lifecycle', event: { type: 'start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-end', runId: invocationId, reason: 'failed' } },
      { kind: 'step-lifecycle', event: { type: 'step-start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-end', runId: invocationId, reason: 'complete' } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId, reason: 'complete' } },
    ]);
    const steps = lifecycle.flatMap((event) => (event.kind === 'step-lifecycle' ? [event.event] : []));
    expect(new Set(steps.map((step) => step.stepId)).size).toBe(1);
    const starts = steps.filter((step) => step.type === 'step-start');
    const ends = steps.filter((step) => step.type === 'step-end');
    expect(ends.map((end) => end.stepStartSerial)).toEqual(starts.map((start) => start.serial));
    const [deadSerial = '', winningSerial = ''] = starts.map((step) => step.serial);
    expect(winningSerial.localeCompare(deadSerial)).toBeGreaterThan(0);

    // Supersede is a reader rule, not a wire erasure: the dead attempt's output
    // is still delivered, and taking the larger serial is what resolves it.
    // Assembling everything would concatenate both attempts.
    const everything = received.events.flatMap((event) => (event.kind === 'message' ? event.outputs : []));
    expect(assembleText(everything)).toContain(DEAD_ATTEMPT_TEXT);

    const winning = received.events.flatMap((event) =>
      event.kind === 'message' && event.meta.stepStartSerial === winningSerial ? event.outputs : [],
    );
    expect(assembleText(winning)).toBe('the complete answer');

    client.close();
  });

  it('re-enters one run when the same invocation id opens twice', async () => {
    // What a fresh-process retry of the plugin's `openRun` looks like on the
    // channel: a second `ai-run-start` under the same pinned run id, rather
    // than a parallel run the browser is not watching.
    const channelName = uniqueChannelName('tmp-reopen');

    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    const invocationId = crypto.randomUUID();
    const args: [FixtureInput] = [
      { invocation: { channelName, inputEventId: sent.eventId }, invocationId, reply: 'unused' },
    ];
    const handle = await env.client.workflow.start('opensTwice', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });

    await handle.result();
    await received.waitForEvent((event) => event.kind === 'run-lifecycle' && event.event.type === 'end');

    // Two opens, one run: the second `ai-run-start` references the run id the first
    // published rather than opening a run alongside it.
    expect(received.events.filter((event) => event.kind === 'run-lifecycle')).toMatchObject([
      { kind: 'run-lifecycle', event: { type: 'start', runId: invocationId } },
      { kind: 'run-lifecycle', event: { type: 'start', runId: invocationId } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId } },
    ]);

    client.close();
  });

  it('ends a run whose inference failed, so a waiting browser unsticks', async () => {
    const channelName = uniqueChannelName('tmp-cleanup');

    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    // `failWithoutTerminal` in ./activities.ts publishes partial output, ends
    // its step `failed`, and throws a non-retryable failure without publishing
    // a run terminal. So the run is left open, and `withRun`'s cleanup arm is
    // the only thing that can close it.
    const invocationId = crypto.randomUUID();
    const args: [FixtureInput] = [
      { invocation: { channelName, inputEventId: sent.eventId }, invocationId, reply: 'thinking' },
    ];
    const handle = await env.client.workflow.start('inferenceFails', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });
    await expect(handle.result()).rejects.toThrow();

    const ended = await received.waitForEvent((event) => event.kind === 'run-lifecycle' && event.event.type === 'end');
    expect(ended).toMatchObject({ kind: 'run-lifecycle', event: { type: 'end', reason: 'error' } });

    const terminal = ended.kind === 'run-lifecycle' ? ended.event : undefined;
    const error = terminal?.type === 'end' && terminal.reason === 'error' ? terminal.error : undefined;
    expect(error).toBeErrorInfoWithCode(ErrorCode.RunResponseStreamFailed);
    // The activity's own message, not Temporal's `Activity task failed` wrapper
    // that the workflow actually catches.
    expect(error?.message).toContain('inference exploded');
    expect(received.events.some((event) => event.kind === 'message' && event.outputs.length > 0)).toBe(true);

    client.close();
  });

  it('still ends the run when the workflow itself is cancelled', async () => {
    // The cleanup arm runs in a non-cancellable scope, which is the case that
    // matters most: without it a cancelled workflow leaves the browser waiting
    // on a stream that never ends.
    const channelName = uniqueChannelName('tmp-cancel');

    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    const invocationId = crypto.randomUUID();
    const args: [FixtureInput] = [
      { invocation: { channelName, inputEventId: sent.eventId }, invocationId, reply: 'thinking' },
    ];
    const handle = await env.client.workflow.start('parksAfterAnswering', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });

    // Wait for text rather than any output event: a streamed message opens on
    // its first delivery and its text arrives on a later append.
    await received.waitFor((all) =>
      all.some((event) => event.kind === 'message' && event.outputs.some((output) => output.type === 'text-delta')),
    );
    await handle.cancel();
    await expect(handle.result()).rejects.toThrow();

    // The cancel lands mid-answer. The answering activity is scheduled without
    // a heartbeat timeout, so Temporal's cancel never reaches it: it finishes
    // its reply and ends its step `complete` on its own connection, while the
    // cleanup arm ends the run `error` on another. Both land, and which lands
    // first is a race between two connections, so the bracket is asserted per
    // kind rather than as one ordered list.
    await received.waitFor(stepAndRunEnded);
    const lifecycle = lifecycleOf(received.events);
    expect(lifecycle).toHaveLength(4);
    expect(lifecycle.filter((event) => event.kind === 'run-lifecycle')).toMatchObject([
      { kind: 'run-lifecycle', event: { type: 'start', runId: invocationId } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId, reason: 'error' } },
    ]);
    expect(lifecycle.filter((event) => event.kind === 'step-lifecycle')).toMatchObject([
      { kind: 'step-lifecycle', event: { type: 'step-start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-end', runId: invocationId, reason: 'complete' } },
    ]);

    client.close();
  });

  it('leaves both terminals on the channel when the run is ended twice', async () => {
    // What a retry of the plugin's `endRun` after a publish-then-crash puts on
    // the wire. Neither the transport nor the channel dedupes, so a reader
    // absorbs it by honouring the first terminal in serial order.
    const channelName = uniqueChannelName('tmp-double');

    const client = createClientTransport<UserPrompt, TextChunk>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<UserPrompt, TextChunk>();
    client.subscribe(received.record);

    const sent = await client.publishInput(prompt);

    const invocationId = crypto.randomUUID();
    const args: [FixtureInput] = [
      { invocation: { channelName, inputEventId: sent.eventId }, invocationId, reply: 'answered once' },
    ];
    const handle = await env.client.workflow.start('endsTwice', {
      workflowId: invocationId,
      taskQueue: TASK_QUEUE,
      args,
    });

    await handle.result();
    await received.waitFor(
      (all) => all.filter((event) => event.kind === 'run-lifecycle' && event.event.type === 'end').length === 2,
    );

    // One run and one step, then two terminals: the step ends `complete`
    // inside the answering activity, and endRun publishes twice.
    const lifecycle = lifecycleOf(received.events);
    expect(lifecycle).toMatchObject([
      { kind: 'run-lifecycle', event: { type: 'start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-start', runId: invocationId } },
      { kind: 'step-lifecycle', event: { type: 'step-end', runId: invocationId, reason: 'complete' } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId, reason: 'complete' } },
      { kind: 'run-lifecycle', event: { type: 'end', runId: invocationId, reason: 'complete' } },
    ]);
    // Delivery order is serial order, so the first delivered is the one to honour.
    const ends = lifecycle.flatMap((event) =>
      event.kind === 'run-lifecycle' && event.event.type === 'end' ? [event.event] : [],
    );
    const bySerial = ends.toSorted((a, b) => (a.serial ?? '').localeCompare(b.serial ?? ''));
    expect(bySerial[0]).toBe(ends[0]);

    client.close();
  });
});
