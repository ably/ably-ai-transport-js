/**
 * The durable activities that make up an AIT turn on Vercel Workflows.
 *
 * Each exported `"use step"` function is one activity — a separate WDK process
 * (a fresh invocation). The uniform envelope every activity runs inside (fresh
 * Ably client + standalone AIT `AgentTransport`, teardown, demo telemetry)
 * lives in {@link withActivity}; the bodies below are the AIT transport calls
 * that make the durable turn work.
 *
 * The composition is a **driver-owned agent loop** (see `ait-turn.ts`): the
 * workflow owns each model call and each server-tool execution as its own
 * retryable activity, rather than letting the AI SDK's internal multi-step
 * loop run tools inline. So the model call strips server `execute`s
 * ({@link stripToolExecutes}), each inference classifies what the model
 * emitted ({@link pendingToolCalls} / {@link approvedPendingToolCalls}), and
 * the workflow dispatches one {@link toolActivity} per server call before
 * looping a follow-up {@link inferenceActivity}.
 *
 * Each interaction with the channel is its own activity:
 *
 * - {@link openActivity} locates the trigger and publishes the run's opening
 *   event (`ai-run-start`, or `ai-run-resume` when the trigger names a run).
 * - {@link inferenceActivity} re-enters the run with `adoptRun`, folds
 *   channel history into model context, streams one model call through an AIT
 *   step, and classifies the outcome — publishing no lifecycle itself.
 * - {@link toolActivity} re-enters the same way and publishes one server-tool
 *   result under its own AIT step.
 * - {@link terminalActivity} re-enters the same way and publishes the run's
 *   `ai-run-end`; {@link cleanupActivity} is its best-effort failure arm.
 *
 * Two rules keep the cross-process lifecycle sound:
 *
 * - **Gate before publishing.** Every re-entering activity folds the run's
 *   lifecycle from channel history first and publishes only while the run is
 *   still this workflow's to drive — a run another invocation already ended
 *   or resumed is left alone, so a slow retry never clobbers work that
 *   already moved on.
 * - **Retries supersede.** An activity keys its AIT step on the WDK step id
 *   (stable across retries) and pins the run and response-message identity, so
 *   a fresh-process retry re-enters the SAME run and its output supersedes the
 *   dead attempt's — no parallel run, no duplicate reply.
 */

import * as Ably from 'ably';
import { convertToModelMessages, stepCountIs, streamText, toUIMessageStream } from 'ai';
import type { UIMessageChunk } from 'ai';
import { RetryableError } from 'workflow';
import { ErrorCode, type RunLifecycleEvent } from '@ably/ai-transport';
import {
  approvedPendingToolCalls,
  pendingToolCalls,
  stripToolExecutes,
  vercelRunOutcome,
  type PendingToolCall,
} from '@ably/ai-transport/vercel';

import { createModel } from '../api/chat/model';
import { tools } from '../api/chat/tools';
import type { FaultMode } from '../lib/fault';
import { foldChunkList, foldMessages, type WdkTransportEvent } from '../lib/fold-messages';
import { withActivity } from './activity-runtime';
import type { AitTurnInput } from './ait-turn';
import { collectHistory, latestRunLifecycle, type WdkAgentTransport } from './history';

const SYSTEM_PROMPT = 'You are a helpful assistant running inside a durable Vercel Workflow. Keep replies concise.';

/** How long the open activity waits for its opening event to echo back before failing for a WDK retry. */
const OPEN_ECHO_TIMEOUT_MS = 15_000;

/**
 * The run identity the open activity establishes and every later activity
 * re-enters by. Plain data, so the workflow threads it across processes.
 */
export interface RunRefs {
  /** The AIT run id — pinned to the workflow run id for a fresh turn, or the trigger's run id for a continuation. */
  runId: string;
  /** The invocation id the open activity publishes the opening event under (`inv:<workflowRunId>`). */
  invocationId: string;
}

/** One server tool call the inference surfaced for the workflow to dispatch. */
export interface ToolCallInfo {
  /** The tool call's id — stable per call, opaque to the demo. */
  toolCallId: string;
  /** The tool's name (a key in the server `tools` registry). */
  toolName: string;
  /** The tool's parsed input, as the model provided it. */
  input: unknown;
}

/**
 * The outcome an inference returns for the workflow to route on. No outcome
 * has been published to the channel yet — `server-tools` loops into tool
 * activities, `settled` means another invocation already owns or finished the
 * run (nothing left for this workflow to publish), and everything else is
 * handed to {@link terminalActivity} to publish.
 */
export type InferenceOutcome =
  | { kind: 'complete' }
  | { kind: 'awaiting-client' }
  | { kind: 'cancelled' }
  | { kind: 'error'; errorMessage: string }
  | { kind: 'server-tools'; serverToolCalls: ToolCallInfo[] }
  | { kind: 'settled' };

// ---------------------------------------------------------------------------
// The activities
// ---------------------------------------------------------------------------

/**
 * OPEN: locate the triggering input in channel history, open the run, and
 * publish its opening event — `ai-run-start` for a fresh turn, `ai-run-resume`
 * when the trigger carries a run id (a tool-result or approval continuation).
 * Nothing more: the first inference is its own {@link inferenceActivity}, so
 * an inference failure retries the inference alone (never re-publishing the
 * open), and the refs reach the workflow before any inference runs, so a later
 * failure past its retries still has refs to hand {@link cleanupActivity}.
 *
 * Retry-safe: the runId is pinned to the (replay-stable) workflow run id, and
 * the opening event is decided by the trigger's own run-id header. A WDK retry
 * re-enters the SAME run, so its duplicate opening event is a re-entry of one
 * run, never a parallel one.
 * @param input - The turn input the chat route started the workflow with.
 * @param workflowRunId - The WDK workflow run id (stable across replays).
 */
export async function openActivity(input: AitTurnInput, workflowRunId: string): Promise<RunRefs> {
  'use step';
  return withActivity(input.channelName, workflowRunId, 'open', async ({ transport, reportAitRun }) => {
    // The trigger was published before this fresh process attached, so it sits
    // in channel history. A retry that cannot find it throws before publishing
    // and leaves no orphaned run.
    const located = await transport.locateInput(input.eventId);
    if (!located) {
      throw new RetryableError(`input event ${input.eventId} not found in channel history`, { retryAfter: '1s' });
    }

    // Opening from the located input anchors the run to its trigger. The run
    // id is pinned to the workflow run id, so a retried process re-enters the
    // same run; the client resolves that id off the channel, never from the
    // route's response.
    const invocationId = `inv:${workflowRunId}`;
    const run = transport.openRun({
      input: located,
      runId: `run:${workflowRunId}`,
      invocationId,
    });
    reportAitRun(run.runId);

    // Await the opening event's own channel echo before returning, so the
    // hand-off to the next activity happens strictly after the open is on the
    // wire (openRun publishes without awaiting; only output verbs await it).
    // Subscribing after openRun is safe: no await separates them, so the echo
    // cannot be delivered in between.
    await awaitRunOpen(transport, run.runId);

    return { runId: run.runId, invocationId };
  });
}

/**
 * INFERENCE: re-enter the open run (`adoptRun`) and run one model call
 * as one AIT step, classifying the result into an {@link InferenceOutcome}.
 * Publishes output only — the run lifecycle belongs to
 * {@link terminalActivity}. Drives every inference: the first (right after
 * {@link openActivity}) and each follow-up the workflow schedules after
 * server-tool activities, so the model sees their published outputs.
 *
 * The history fold is both gate and context. The gate: a run that ended,
 * ended or was resumed by another invocation is no longer this workflow's
 * to drive — return the observed outcome (or `settled`) and publish nothing,
 * so a slow retry never re-runs the model over a continuation that already
 * moved on. The recovery reads: an approval that just landed dispatches the
 * approved calls directly, and a dead attempt's already-streamed tool calls
 * are routed instead of re-inferred.
 * @param input - The turn input (carries the channel name).
 * @param refs - The run refs from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param fault - Optional fault to inject (the workflow passes it only to the first inference).
 */
export async function inferenceActivity(
  input: AitTurnInput,
  refs: RunRefs,
  workflowRunId: string,
  fault?: FaultMode,
): Promise<InferenceOutcome> {
  'use step';
  return withActivity(
    input.channelName,
    workflowRunId,
    'inference',
    async ({ transport, stepId, attempt, reportAitRun }) => {
      reportAitRun(refs.runId);
      const events = await collectHistory(transport);

      const gate = gateRun(events, refs);
      if (gate) return gate;

      const run = transport.adoptRun(refs.runId, { invocationId: refs.invocationId });

      // Recovery reads over the full fold (the dead attempt's output included —
      // its streamed tool calls may already be answered on the wire).
      const messages = await foldMessages(events);

      // A tool-approval-response just landed: the approved call's output is
      // owed, but feeding the approval pair back through the model is
      // unreliable on real providers. Dispatch the approved call directly.
      const approved = filterServerToolCalls(approvedPendingToolCalls(messages));
      if (approved.length > 0) return { kind: 'server-tools', serverToolCalls: approved };

      // A prior (dead) attempt of THIS activity already streamed tool calls,
      // which the client may have answered by now. Route those instead of
      // re-running the model, so recovery completes the bookkeeping without
      // redoing finished work.
      //
      // The ownership check is what keeps this honest. `pendingToolCalls`
      // reads the newest assistant message in whatever list it is given, so
      // without the check an unanswered call left by an EARLIER turn (a
      // cancelled getLocation, a tab closed before the resolution published)
      // would be picked up by every later send — each one returning here
      // without ever calling the model, and the conversation never replying
      // again. The response-message id is pinned to this activity's step id
      // below, so only that message can be this attempt's own.
      const streamedHere = messages.findLast((message) => message.role === 'assistant')?.id === `msg:${stepId}`;
      const unresolved = streamedHere ? pendingToolCalls(messages) : [];
      if (unresolved.length > 0) {
        const server = filterServerToolCalls(unresolved);
        return server.length > 0 ? { kind: 'server-tools', serverToolCalls: server } : { kind: 'awaiting-client' };
      }

      // Demo fault: throw before anything is published, so the dead attempt
      // leaves nothing on the wire and the WDK retry (attempt 2) streams the
      // reply once. (A retry after a mid-stream crash is also safe — the step
      // is keyed on the stable WDK step id and the response-message id is
      // pinned below, so a retry's output supersedes the dead attempt's in the
      // durable record.)
      injectFault(fault, attempt);

      // Model context excludes this activity's own step: the attempt about to
      // stream supersedes that step's prior output on the wire, so the prompt
      // must not carry it either (a trailing assistant message reads as a
      // prefill and real providers reject it).
      const conversation = await foldMessages(events, { excludeStepId: stepId });
      if (conversation.length === 0) {
        // Never hand streamText an empty prompt ("messages must not be empty").
        return { kind: 'error', errorMessage: 'history fold returned no messages' };
      }

      const result = streamText({
        model: createModel(),
        system: SYSTEM_PROMPT,
        messages: await convertToModelMessages(conversation),
        // The workflow drives multi-step, so strip server `execute`s: the model
        // emits its tool calls and stops rather than running them inline.
        tools: stripToolExecutes(tools),
        stopWhen: stepCountIs(1),
        abortSignal: run.abortSignal,
      });

      // The AIT step is keyed on the WDK step id, so a retry supersedes the
      // dead attempt's output. The response-message id is pinned to the same
      // key, so a client folding the wire replaces the dead attempt's message
      // instead of appending a duplicate.
      const step = run.createStep({ stepId });
      const uiStream = toUIMessageStream({
        stream: result.fullStream,
        generateMessageId: () => `msg:${stepId}`,
      });
      // Tee the chunk stream: one branch publishes, the other is this
      // process's own copy for classifying the streamed tool calls (no wait
      // on the wire echo).
      const [wireBranch, localBranch] = uiStream.tee();
      const collected = collectChunks(localBranch);
      const pipeResult = await step.pipe(wireBranch);
      const streamedChunks = await collected;

      const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
      await step.end(outcome.reason === 'error' ? { reason: 'failed' } : {});

      if (outcome.reason === 'error') return { kind: 'error', errorMessage: outcome.error.message };
      if (outcome.reason === 'cancelled') return { kind: 'cancelled' };
      if (outcome.reason === 'complete') return { kind: 'complete' };

      // The model stopped on tool calls: server calls (execute in the
      // registry) become tool activities; anything else (client tools,
      // approval-gated tools) ends the turn for the client to resolve.
      const streamedMessage = await foldChunkList(streamedChunks);
      const server = filterServerToolCalls(pendingToolCalls(streamedMessage ? [streamedMessage] : []));
      return server.length > 0 ? { kind: 'server-tools', serverToolCalls: server } : { kind: 'awaiting-client' };
    },
  );
}

/**
 * TOOL: execute ONE server tool and publish its result as a single
 * `tool-output-available` message under its own AIT step. A throw retries
 * under the same stepId, so the retry's output supersedes the failed
 * attempt's. Gated like every re-entering activity: a run that already moved
 * on gets nothing published.
 * @param input - The turn input (carries the channel name).
 * @param refs - The run refs from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param toolCall - The server tool call to execute.
 */
export async function toolActivity(
  input: AitTurnInput,
  refs: RunRefs,
  workflowRunId: string,
  toolCall: ToolCallInfo,
): Promise<void> {
  'use step';
  await withActivity(input.channelName, workflowRunId, 'tool', async ({ transport, stepId, reportAitRun }) => {
    reportAitRun(refs.runId);
    const events = await collectHistory(transport);
    if (gateRun(events, refs)) return;

    const run = transport.adoptRun(refs.runId, { invocationId: refs.invocationId });
    const step = run.createStep({ stepId });
    const output = await executeServerTool(toolCall);
    await step.send({ type: 'tool-output-available', toolCallId: toolCall.toolCallId, output });
    await step.end({});
  });
}

/**
 * TERMINAL: publish the `ai-run-end` the inference outcome implies. A turn
 * left waiting on the client (a client-executed tool, an unanswered approval)
 * still ends: the useChat adapter publishes each resolution as a plain input
 * carrying no run id, so the continuation opens a fresh run and a suspended
 * one would never be resumed. Its own activity so a process that dies between
 * producing the outcome and publishing it is retried here alone, and the gate
 * keeps the retry honest: a run another invocation already ended or resumed
 * gets nothing published.
 * @param input - The turn input (carries the channel name).
 * @param refs - The run refs from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param outcome - The inference outcome to publish (never `server-tools` or `settled`).
 */
export async function terminalActivity(
  input: AitTurnInput,
  refs: RunRefs,
  workflowRunId: string,
  outcome: Exclude<InferenceOutcome, { kind: 'server-tools' } | { kind: 'settled' }>,
): Promise<void> {
  'use step';
  await withActivity(input.channelName, workflowRunId, 'terminal', async ({ transport, reportAitRun }) => {
    reportAitRun(refs.runId);
    const events = await collectHistory(transport);
    if (gateRun(events, refs)) return;

    const run = transport.adoptRun(refs.runId, { invocationId: refs.invocationId });
    switch (outcome.kind) {
      case 'awaiting-client':
        // The client owes a tool result or an approval. Nothing resumes this
        // run, so end it complete and let the resolution wake a new one.
        await run.end({ reason: 'complete' });
        return;
      case 'error':
        await run.end({
          reason: 'error',
          error: new Ably.ErrorInfo(outcome.errorMessage, ErrorCode.RunResponseStreamFailed, 500),
        });
        return;
      default:
        await run.end({ reason: outcome.kind });
    }
  });
}

/**
 * CLEANUP: the workflow-level failure terminal, scheduled from the workflow's
 * catch once an activity has failed past its retry policy. Publishes
 * `ai-run-end{error}` so observers' streams close instead of hanging. The
 * gate makes it safe: a run another invocation already ended or moved to a
 * continuation needs nothing. Best-effort: one attempt, no retries.
 * @param input - The turn input (carries the channel name).
 * @param refs - The run refs from {@link openActivity}.
 * @param workflowRunId - The WDK workflow run id.
 * @param errorMessage - The failure to stamp on the run terminal.
 */
export async function cleanupActivity(
  input: AitTurnInput,
  refs: RunRefs,
  workflowRunId: string,
  errorMessage: string,
): Promise<void> {
  'use step';
  await withActivity(input.channelName, workflowRunId, 'cleanup', async ({ transport, reportAitRun }) => {
    reportAitRun(refs.runId);
    const events = await collectHistory(transport);
    const latest = latestRunLifecycle(events, refs.runId);
    // A run whose opening event is not visible has nothing this best-effort
    // arm can safely end; an already-settled or taken-over run needs nothing.
    if (!latest || isSettledOrTakenOver(latest, refs)) return;

    const run = transport.adoptRun(refs.runId, { invocationId: refs.invocationId });
    await run.end({ reason: 'error', error: new Ably.ErrorInfo(errorMessage, ErrorCode.RunResponseStreamFailed, 500) });
  });
}

// Cleanup is best-effort and must not cascade: one attempt, no retries.
cleanupActivity.maxRetries = 0;

// ---------------------------------------------------------------------------
// Shared gate + helpers
// ---------------------------------------------------------------------------

/**
 * Whether the run's latest lifecycle event says it is no longer this
 * workflow's to drive: it ended, or a different invocation (a
 * client continuation's workflow) re-entered it.
 */
function isSettledOrTakenOver(latest: RunLifecycleEvent, refs: RunRefs): boolean {
  if (latest.type === 'end' || latest.type === 'suspend') return true;
  return latest.type === 'resume' && latest.invocationId !== refs.invocationId;
}

/**
 * The re-entry gate every activity folds before publishing. Returns the
 * outcome to short-circuit with when the run is not (or no longer) this
 * workflow's to drive, or undefined to proceed.
 * @param events - Collected history events, oldest first.
 * @param refs - The run refs from {@link openActivity}.
 */
function gateRun(events: WdkTransportEvent[], refs: RunRefs): InferenceOutcome | undefined {
  const latest = latestRunLifecycle(events, refs.runId);
  if (!latest) {
    // The opening event is not visible from this attach point yet — a
    // propagation artefact; throw so WDK retries this activity.
    throw new RetryableError(`run ${refs.runId} opening event not found in channel history`, { retryAfter: '1s' });
  }
  if (latest.type === 'end') {
    // Someone already ended the run: report what the wire says and publish
    // nothing further.
    if (latest.reason === 'error') return { kind: 'error', errorMessage: latest.error.message };
    if (latest.reason === 'cancelled') return { kind: 'cancelled' };
    return { kind: 'complete' };
  }
  if (isSettledOrTakenOver(latest, refs)) return { kind: 'settled' };
  return undefined;
}

/** Narrow pending tool calls to the server-executed ones the workflow dispatches as tool activities. */
function filterServerToolCalls(calls: readonly PendingToolCall[]): ToolCallInfo[] {
  return calls
    .filter((call) => typeof tools[call.toolName]?.execute === 'function')
    .map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }));
}

/** Look up and run one server tool from the registry by the model-provided name + input. */
function executeServerTool(toolCall: ToolCallInfo): Promise<unknown> {
  // CAST: registry lookup by model-provided name — a trust boundary; the
  // workflow only dispatches calls filterServerToolCalls confirmed have execute.
  const tool = (tools as Record<string, { execute?: (input: unknown) => Promise<unknown> }>)[toolCall.toolName];
  if (!tool?.execute) throw new Error(`tool '${toolCall.toolName}' has no execute`);
  return tool.execute(toolCall.input);
}

/** Drain a chunk stream into an array (the local branch of the inference tee). */
async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

/**
 * Resolve once the run's opening event (`ai-run-start` / `ai-run-resume`)
 * echoes back on the receive stream — the confirmation that the open reached
 * the wire, so the open activity can report success and hand off. Fails after
 * {@link OPEN_ECHO_TIMEOUT_MS} so a lost publish surfaces as a WDK retry.
 * @param transport - The connected transport to observe (subscribe happens before openRun).
 * @param runId - The run whose opening echo to await.
 */
function awaitRunOpen(transport: WdkAgentTransport, runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`run ${runId} opening event did not echo within ${String(OPEN_ECHO_TIMEOUT_MS)}ms`));
    }, OPEN_ECHO_TIMEOUT_MS);
    unsubscribe = transport.subscribe((event) => {
      if (event.kind !== 'run-lifecycle' || event.event.runId !== runId) return;
      if (event.event.type === 'start' || event.event.type === 'resume') {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Demo control: on an activity's FIRST attempt, throw so WDK retries it as a
 * fresh process — the durable-retry story on demand. The retry re-enters the
 * SAME run (pinned run id) and the SAME step (stable WDK step id), so the
 * reply lands once. `fail-once` throws a WDK {@link RetryableError} (a
 * graceful, expected transient failure, with a backoff); `crash` throws a
 * plain Error (an unhandled bug / worker crash, retried on WDK's default
 * schedule).
 */
function injectFault(fault: FaultMode | undefined, attempt: number): void {
  if (attempt !== 1) return;
  if (fault === 'fail-once') throw new RetryableError('injected fault: fail once', { retryAfter: '1s' });
  if (fault === 'crash') throw new Error('injected fault: simulated worker crash');
}
