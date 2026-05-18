/**
 * Temporal activities backing the {@link runAgent} workflow.
 *
 * Each AIT step is one Temporal activity:
 *
 *   - {@link openRun} binds an {@link AgentRun} on the AIT session, caches
 *     it by `runId`, and returns the canonical conversation history as
 *     `AI.ModelMessage`s so the workflow can feed the first
 *     `streamText` call.
 *   - {@link streamStep} runs one model call (with any tools the model
 *     invokes) via `streamText`, pipes the resulting `UIMessageChunk`
 *     stream through the AIT step, and returns the iteration's finish
 *     reason and response messages so the workflow can decide whether
 *     to keep looping.
 *   - {@link endRun} ends the run (cleanly or with an error) and clears
 *     the cached handle.
 *
 * Tool execute functions run in-process inside `streamStep` — they don't
 * become their own Temporal activities. Keeping the LLM call and its
 * tool fan-out inside one activity keeps the wire shape close to the
 * vercel demo (one `streamText` per step) and avoids passing tool
 * call/result blobs through the workflow.
 */

import { Context } from '@temporalio/activity';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getClientSession, getSession, publishOnSessionChannel } from '../lib/agent-session';
import { dropBashToolkit, getBashToolkit } from '../lib/bash-session';
import { deleteRun, getRun, setRun } from '../lib/run-cache';
import { SPAWN_SUBAGENT_TOOL_NAME, type SpawnSubagentInput, spawnSubagentToolFor } from '../lib/spawn-subagent-tool';
import { SUBAGENT_LINK_MESSAGE_NAME, type SubagentLink } from '../lib/subagent-link';

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

/**
 * Per-step duration cap. One minute is comfortably longer than a single
 * `streamText` call should take while still bounding the wait for a
 * step-start ack on a misconfigured channel.
 */
const STEP_TIMEOUT_MS = 60_000;

/**
 * Number of `text-delta` chunks to forward before the synthetic failure
 * fires. Mirrors the vercel demo's behaviour so the user sees a partial
 * assistant bubble before the catch path lands a failed step-end.
 *
 * Only applied on the activity's first attempt — see `streamStep` below.
 * Temporal's retry of the activity then succeeds and the run completes
 * normally, demonstrating automatic recovery from a transient failure.
 */
const FAIL_AFTER_TEXT_DELTAS = 3;

/**
 * Wrap a `UIMessageChunk` stream so it errors after the model has
 * emitted {@link FAIL_AFTER_TEXT_DELTAS} text-delta chunks.
 */
const streamThatFailsAfterPartialText = (
  source: ReadableStream<AI.UIMessageChunk>,
): ReadableStream<AI.UIMessageChunk> => {
  const reader = source.getReader();
  let textDeltaCount = 0;
  return new ReadableStream<AI.UIMessageChunk>({
    pull: async (controller) => {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      if (value.type === 'text-delta') {
        textDeltaCount++;
        if (textDeltaCount >= FAIL_AFTER_TEXT_DELTAS) {
          controller.error(new Error('simulated agent failure'));
        }
      }
    },
    cancel: (reason) => {
      reader.cancel(reason).catch(() => {
        /* swallow — best-effort upstream cancel */
      });
    },
  });
};

export async function openRun(data: InvocationData): Promise<void> {
  const invocation = Invocation.fromJSON(data);
  const session = await getSession(invocation.sessionName);
  const signal = Context.current().cancellationSignal;

  const run = await session.createRun(invocation, { signal });
  setRun(invocation.runId, run);
}

export interface StreamStepArgs {
  runId: string;
  /** Session name — used to resolve the bash toolkit for this run. */
  sessionName: string;
  /**
   * Current agent depth — `0` for the user-facing root agent, `1` for a
   * subagent it spawned, and so on. Determines whether the
   * `spawn_subagent` tool is exposed to the model on this step.
   */
  depth: number;
  /**
   * Loop iteration on the parent workflow (0 on the first model call of
   * a run). Used together with `depth === 0` to decide whether to inject
   * the demo's first-turn forcing system prompt: a user who mentions
   * "subagent" / "parallel" / "spawn" / "fan out" in their prompt gets
   * an extra instruction nudging the model to actually call
   * `spawn_subagent` rather than just running bash itself.
   */
  iteration: number;
  /**
   * Subagent results the workflow has accumulated for this run across
   * prior fan-out cycles. Threaded in so we can hydrate the run's
   * `tool-spawn_subagent` parts locally without depending on Ably's
   * echo-back of the `tool-output-available` chunks landing before this
   * activity runs. Empty/undefined on the first iteration.
   */
  priorSubagentResults?: SubagentResultArg[];
  /**
   * When true on the activity's first attempt, the step publishes a few
   * text-delta chunks then errors so the catch path lands a failed
   * step-end on the channel. The activity throws, Temporal retries it,
   * and the second attempt ignores the flag and runs normally — so the
   * run ultimately completes successfully after a visible transient
   * failure. The flag is effectively self-clearing across retries.
   */
  simulateFail?: boolean;
}

/**
 * Keywords that trigger the demo's first-turn forcing system prompt. A
 * user message mentioning any of these phrases (case-insensitive) on the
 * root run's opening turn tells us they're explicitly trying to exercise
 * the subagent path, so we add an instruction that strongly biases the
 * model toward calling `spawn_subagent` instead of running the work
 * inline. Demo-only — production agents would rely on prompt design and
 * model choice rather than a keyword switch.
 */
const FORCING_TRIGGERS = ['subagent', 'sub-agent', 'parallel', 'spawn', 'fan out', 'fan-out', 'in parallel'];

const FORCING_SYSTEM_PROMPT = `The user is asking you to use subagents for this task. You MUST call the spawn_subagent tool — one call per independent piece of work — instead of doing the work yourself in this turn.

Identify the independent pieces from the user's request. Then, in a single response, emit one spawn_subagent tool call per piece. They will run as parallel Temporal child workflows. After all subagents return, you can compose a final reply using their outputs.

Do NOT run bash or write any files yourself in this turn. Delegate everything to subagents.`;

/** Concatenate every text part on a UIMessage. */
const messageText = (message: AI.UIMessage): string =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

/**
 * Inspect the run's latest user message and decide whether to force the
 * model into the subagent path on this turn. Returns the system prompt
 * to pass to `streamText`, or undefined to leave the model untouched.
 */
const maybeForcingSystem = (run: {
  view: { messages: readonly { role: string; message: AI.UIMessage }[] };
}): string | undefined => {
  let latestUserText = '';
  for (const node of run.view.messages) {
    if (node.role === 'user') latestUserText = messageText(node.message);
  }
  const haystack = latestUserText.toLowerCase();
  return FORCING_TRIGGERS.some((trigger) => haystack.includes(trigger)) ? FORCING_SYSTEM_PROMPT : undefined;
};

/**
 * One unresolved `spawn_subagent` tool call captured from the model's
 * output, surfaced to the workflow so it can start child workflows.
 */
export interface PendingSubagentCall {
  /** The toolCallId the model assigned to this call. Used to correlate the tool-output back. */
  toolCallId: string;
  /** The parsed input the model produced for the spawn_subagent tool. */
  input: SpawnSubagentInput;
}

export interface StreamStepResult {
  /** Finish reason from the model. The workflow stops looping when it isn't `'tool-calls'`. */
  finishReason: AI.FinishReason;
  /**
   * True when the activity already ended the run (after observing an
   * abort). The workflow uses this to skip its trailing `endRun` so the
   * abort terminal is the only `run-end` published on the channel.
   */
  runEnded?: boolean;
  /**
   * True when an `x-ably-pause` signal had been observed on the run by
   * the time this activity finished. The workflow primarily learns of a
   * pause via the in-process `pauseUpdate`; this flag is the fallback
   * for the case where a pause was published to the channel without a
   * Temporal Update — the activity surfaces it so the workflow can
   * suspend the run on the next loop boundary. Spec: AIT-CS3b.
   */
  pauseRequested?: boolean;
  /**
   * Spawn-subagent tool calls the model emitted that the SDK did not
   * auto-execute (the tool has no `execute` function). The workflow
   * starts one Temporal child workflow per call, then resumes the loop
   * with a `resumeWithToolResults` activity that feeds the children's
   * final text back as `tool-output-available` chunks.
   */
  subagentCalls?: PendingSubagentCall[];
  /**
   * The model's final assistant text from this step. Used by the workflow
   * to surface the leaf return value back to whoever invoked the run —
   * subagents resolve to this string for the parent to feed in as a tool
   * result. Empty string when the step produced no text (e.g. tool-only
   * output).
   */
  text: string;
}

export async function streamStep(args: StreamStepArgs): Promise<StreamStepResult> {
  const run = getRun(args.runId);
  if (run === undefined) {
    throw new Error(`unable to stream step; no cached run for ${args.runId}`);
  }
  const signal = Context.current().cancellationSignal;
  const { tools: bashTools } = await getBashToolkit(args.runId);
  // Merge in the spawn_subagent tool when the depth cap allows it. The
  // tool has no execute fn — the model's call is surfaced in
  // `result.toolCalls` and the workflow handles it out-of-band.
  const tools = { ...bashTools, ...spawnSubagentToolFor(args.depth) };

  const step = run.createStep();
  await step.start({ signal, timeoutMs: STEP_TIMEOUT_MS });

  // Read canonical messages from the run AFTER step.start() lands so
  // any prior failed/aborted step in this run is excluded from the
  // model context. AIT-CN3 flips the predecessor's canonical flag when
  // our new step-start lands; reading before that flip would feed
  // retried/abandoned partial output back into streamText. Spec:
  // AIT-CN2.
  //
  // Use run-scoped `run.messages` (not the session-wide
  // `run.view.messages`) at every depth. The demo's subagents publish
  // their own runs onto the same channel, so the session-wide view
  // would pull subagent conversations into the parent's context — both
  // confusing for the model and brittle against Ably's echo-back
  // ordering (subagent tool-output chunks may arrive at the parent
  // subscriber after the next streamStep starts, leaving the parent's
  // view holding apparently-unresolved tool calls from the subagent's
  // run). The demo is single-turn at root, so we don't lose history by
  // scoping to the run.
  //
  // Hydrate the run's own `tool-spawn_subagent` parts using subagent
  // results the workflow has accumulated for this run. We don't rely on
  // Ably's echo of our own `tool-output-available` publishes landing
  // before the next streamStep — the workflow remembers what came back
  // and threads it through every activity.
  const resultByToolCallId = new Map((args.priorSubagentResults ?? []).map((r) => [r.toolCallId, r.output]));
  const hydratedUIMessages = run.messages
    .filter((node) => node.canonical)
    .map((node) => hydrateSpawnToolResults(node.message, resultByToolCallId));
  const messages = await convertToModelMessages(hydratedUIMessages);

  // Demo aid: only on the root run's opening turn, if the user mentioned
  // "subagent" / "parallel" / etc, inject a forcing system prompt so the
  // model actually exercises the subagent path instead of running every
  // bash command itself.
  const system = args.depth === 0 && args.iteration === 0 ? maybeForcingSystem(run) : undefined;

  try {
    // One model call per AIT step. `streamText` runs any tool calls the
    // model returns before the stream ends, so the step's output covers
    // both the assistant turn and its tool results.
    const result = streamText({
      model: anthropic(MODEL),
      system,
      messages,
      abortSignal: step.signal,
      tools,
      stopWhen: stepCountIs(1),
    });
    const source = result.toUIMessageStream();
    // Only fail on the first attempt. When Temporal retries the activity
    // the simulated-failure wrapper is skipped so the run recovers
    // automatically — this is what makes the demo show Temporal's retry
    // behaviour rather than a permanently-failed run.
    const failThisAttempt = args.simulateFail === true && Context.current().info.attempt === 1;
    const stream = failThisAttempt ? streamThatFailsAfterPartialText(source) : source;
    await step.pipe(stream);
    await step.end();

    const finishReason = await result.finishReason;
    const text = await result.text;
    const toolCalls = await result.toolCalls;
    const subagentCalls: PendingSubagentCall[] = [];
    for (const call of toolCalls) {
      if (call.toolName === SPAWN_SUBAGENT_TOOL_NAME) {
        // CAST: tool input is typed by the tool's inputSchema, but the
        // shared TypedToolCall union widens it. The schema guarantees the
        // shape at runtime; narrow to the known SpawnSubagentInput.
        subagentCalls.push({ toolCallId: call.toolCallId, input: call.input as SpawnSubagentInput });
      }
    }
    // Demo aid: log which tools the model picked this step so it's
    // obvious from the worker terminal whether subagent fan-out fired.
    // eslint-disable-next-line no-console
    console.log(
      `[streamStep] runId=${args.runId} depth=${String(args.depth)} iter=${String(args.iteration)} finishReason=${finishReason} tools=${JSON.stringify(toolCalls.map((c) => c.toolName))}`,
    );
    // Read pauseRequested AFTER step.end so any pause signal that landed
    // during the step's lifetime is reflected in the value the workflow
    // reads. The flag is sticky until a resume signal lands, so observing
    // it here is the right shape for "should we suspend the run?".
    return {
      finishReason,
      pauseRequested: run.pauseRequested,
      subagentCalls: subagentCalls.length > 0 ? subagentCalls : undefined,
      text,
    };
  } catch (error) {
    await step.end(error);
    if (step.signal.aborted) {
      // Caller cancelled the run — end it here so the run-end terminal
      // is classified as `'aborted'` (the classifier needs the original
      // signal-driven error). Returning a marker tells the workflow to
      // skip its trailing `endRun`.
      await run.end(error);
      await run.close();
      deleteRun(args.runId);
      dropBashToolkit(args.runId);
      return { finishReason: 'other', runEnded: true, text: '' };
    }
    throw error;
  }
}

export interface SuspendRunArgs {
  runId: string;
}

/**
 * Publish `x-ably-run-suspend (paused)` on the run's channel. Called
 * between iterations once the workflow has decided to pause — the
 * preceding step has already been ended cleanly, so this activity only
 * needs to drive the run-suspend lifecycle wire.
 *
 * Idempotent against the AIT layer: `AgentRun.suspend()` throws
 * `RunAlreadySuspended` when called twice in a row, so we early-return
 * if the run is already suspended on the channel. Temporal retries are
 * safe because the second activity attempt would otherwise see the run
 * as suspended and short-circuit.
 */
export async function suspendRun(args: SuspendRunArgs): Promise<void> {
  const run = getRun(args.runId);
  if (run === undefined) {
    // Run was already torn down (e.g. a parallel abort path closed it
    // before the workflow's pause handler ran). Nothing to suspend.
    return;
  }
  if (run.status === 'suspended') {
    // Another path (Temporal retry, multi-source pause) already
    // published the run-suspend; don't double-publish.
    return;
  }
  await run.suspend();
}

export interface EndRunArgs {
  runId: string;
  /**
   * Set when the workflow caught an exception during the iteration loop.
   * Forwarded as `run.end(error)` so the AIT classifier picks `'failed'`
   * (or `'aborted'` for signal-driven errors).
   *
   * Activities can only carry serialisable arguments; the workflow
   * forwards the message string and we wrap it back into an Error here.
   */
  errorMessage?: string;
}

export async function endRun(args: EndRunArgs): Promise<void> {
  const run = getRun(args.runId);
  if (run === undefined) {
    // Already closed (e.g. activity retry after a successful close);
    // closing twice is a no-op on the underlying run anyway. Drop the
    // bash toolkit defensively in case the run cache was cleared without
    // the toolkit being released.
    dropBashToolkit(args.runId);
    return;
  }
  try {
    if (args.errorMessage !== undefined) {
      await run.end(new Error(args.errorMessage));
    } else {
      await run.end();
    }
  } finally {
    await run.close();
    deleteRun(args.runId);
    dropBashToolkit(args.runId);
  }
}

export interface SeedSubagentRunArgs {
  /** Session whose channel carries the new run. Shared with the parent. */
  sessionName: string;
  /** Parent run id — recorded on the demo:subagent-link sidecar. */
  parentRunId: string;
  /** The parent's tool-call id that produced this spawn. */
  parentToolCallId: string;
  /** Short human-readable label from the spawn_subagent input. */
  description: string;
  /** Prompt to publish as the subagent's first user message. */
  prompt: string;
}

/**
 * Open a fresh run on the shared session channel on behalf of a parent
 * agent that has just emitted a `spawn_subagent` tool call. Uses the
 * worker's {@link createClientSession} surface to publish the user
 * message + run-start in one atomic Ably batch, returns the resulting
 * {@link InvocationData}, and publishes the demo:subagent-link sidecar
 * so subscribers can link this run back to its parent.
 *
 * The parent workflow uses the returned InvocationData to start a
 * `runAgent` child workflow that drives the subagent.
 */
export async function seedSubagentRun(args: SeedSubagentRunArgs): Promise<InvocationData> {
  const session = await getClientSession(args.sessionName);
  const view = session.createView();
  try {
    const userMsg: AI.UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: args.prompt }],
    };
    const run = await view.send(userMsg);
    const link: SubagentLink = {
      runId: run.id,
      parentRunId: args.parentRunId,
      parentToolCallId: args.parentToolCallId,
      description: args.description,
    };
    // Publish the link AFTER the run-start so a subscriber receiving the
    // link can immediately resolve the runId to a known run. Ably
    // preserves order per connection on a single channel, so live
    // subscribers see run-start then link in that order.
    await publishOnSessionChannel(args.sessionName, SUBAGENT_LINK_MESSAGE_NAME, link);
    return run.toInvocation().toJSON();
  } finally {
    await view.close();
  }
}

export interface SubagentResultArg {
  /** toolCallId of the parent's `spawn_subagent` call this output answers. */
  toolCallId: string;
  /** Final assistant text the child workflow produced. */
  output: string;
}

export interface ResumeWithToolResultsArgs {
  runId: string;
  sessionName: string;
  depth: number;
  /**
   * Cumulative subagent results across every fan-out in this run.
   * Includes both the results from the fan-out we are currently
   * resuming from AND any prior fan-outs in the same run. Used to
   * hydrate every still-`input-available` spawn part on the run's
   * messages — see {@link StreamStepArgs.priorSubagentResults} for the
   * echo-gap motivation.
   */
  results: SubagentResultArg[];
}

/**
 * Open a new step on the parent run that
 *   1. publishes a `tool-output-available` chunk for each completed
 *      subagent (so the channel reflects the resolved tool parts on the
 *      parent's prior assistant message), and
 *   2. resumes `streamText` with a message history that has the same
 *      tool results appended as a `tool` ModelMessage, so the model can
 *      react to the subagents' findings.
 *
 * Returns the same {@link StreamStepResult} shape as {@link streamStep}
 * so the workflow loop can keep iterating uniformly.
 */
export async function resumeWithToolResults(args: ResumeWithToolResultsArgs): Promise<StreamStepResult> {
  const run = getRun(args.runId);
  if (run === undefined) {
    throw new Error(`unable to resume with tool results; no cached run for ${args.runId}`);
  }
  const signal = Context.current().cancellationSignal;
  const { tools: bashTools } = await getBashToolkit(args.runId);
  const tools = { ...bashTools, ...spawnSubagentToolFor(args.depth) };

  const step = run.createStep();
  await step.start({ signal, timeoutMs: STEP_TIMEOUT_MS });

  // Build the model's view of the conversation. We can't just call
  // convertToModelMessages on the raw run — the run's prior assistant
  // message still carries `tool-spawn_subagent` parts in
  // `input-available` state locally (we deliberately did not
  // auto-execute them, and Ably's echo of our own
  // `tool-output-available` publishes may not have arrived back at this
  // subscriber yet). Hydrate those parts to `output-available` from the
  // workflow's accumulator before converting; the resulting UIMessages
  // are internally consistent and serialize cleanly.
  //
  // See streamStep for the run.messages (run-scoped) choice rationale.
  const resultByToolCallId = new Map(args.results.map((r) => [r.toolCallId, r.output]));
  const hydratedUIMessages = run.messages
    .filter((node) => node.canonical)
    .map((node) => hydrateSpawnToolResults(node.message, resultByToolCallId));
  const messages = await convertToModelMessages(hydratedUIMessages);

  try {
    const result = streamText({
      model: anthropic(MODEL),
      messages,
      abortSignal: step.signal,
      tools,
      stopWhen: stepCountIs(1),
    });
    const source = result.toUIMessageStream();
    // Prepend tool-output-available chunks for each completed subagent
    // so the channel reflects the resolved tool parts on the parent's
    // prior assistant message, then chain the live streamText output.
    const stream = prependToolOutputs(source, args.results);
    await step.pipe(stream);
    await step.end();

    const finishReason = await result.finishReason;
    const text = await result.text;
    const toolCalls = await result.toolCalls;
    const subagentCalls: PendingSubagentCall[] = [];
    for (const call of toolCalls) {
      if (call.toolName === SPAWN_SUBAGENT_TOOL_NAME) {
        // CAST: see streamStep for the same narrowing rationale.
        subagentCalls.push({ toolCallId: call.toolCallId, input: call.input as SpawnSubagentInput });
      }
    }
    return {
      finishReason,
      pauseRequested: run.pauseRequested,
      subagentCalls: subagentCalls.length > 0 ? subagentCalls : undefined,
      text,
    };
  } catch (error) {
    await step.end(error);
    if (step.signal.aborted) {
      await run.end(error);
      await run.close();
      deleteRun(args.runId);
      dropBashToolkit(args.runId);
      return { finishReason: 'other', runEnded: true, text: '' };
    }
    throw error;
  }
}

/**
 * Return a copy of `message` with any `tool-spawn_subagent` part whose
 * toolCallId appears in `resultByToolCallId` transitioned from
 * `input-available` to `output-available`, carrying the subagent's text
 * as the tool output. Messages without matching parts are returned
 * unchanged (no allocation), so this is cheap to map over the view.
 *
 * The tool part keeps its `input`, `toolCallId`, `providerExecuted`,
 * `providerMetadata` — we only flip `state` and add `output`. That's
 * what convertToModelMessages needs to emit a clean tool-call /
 * tool-result pair into the model prompt.
 */
const hydrateSpawnToolResults = (
  message: AI.UIMessage,
  resultByToolCallId: ReadonlyMap<string, string>,
): AI.UIMessage => {
  if (message.role !== 'assistant') return message;
  let changed = false;
  const newParts = message.parts.map((part) => {
    if (part.type !== `tool-${SPAWN_SUBAGENT_TOOL_NAME}`) return part;
    // CAST: narrowed by the `tool-${name}` discriminator above. The part
    // is a ToolUIPart for spawn_subagent; we read toolCallId / input /
    // state off it and produce a new part with state=output-available.
    const toolPart = part as AI.ToolUIPart;
    if (toolPart.state !== 'input-available') return part;
    const output = resultByToolCallId.get(toolPart.toolCallId);
    if (output === undefined) return part;
    changed = true;
    return {
      type: toolPart.type,
      toolCallId: toolPart.toolCallId,
      state: 'output-available' as const,
      input: toolPart.input,
      output,
    };
  });
  if (!changed) return message;
  return { ...message, parts: newParts };
};

/**
 * Prepend `tool-output-available` chunks for each completed subagent to
 * the front of a `UIMessageChunk` stream. The AIT encoder publishes them
 * as discrete wires keyed by toolCallId; the receiving accumulator
 * correlates them back to the existing tool-call parts on the parent's
 * prior assistant message.
 */
const prependToolOutputs = (
  source: ReadableStream<AI.UIMessageChunk>,
  results: readonly SubagentResultArg[],
): ReadableStream<AI.UIMessageChunk> => {
  const preface: AI.UIMessageChunk[] = results.map((r) => ({
    type: 'tool-output-available',
    toolCallId: r.toolCallId,
    output: r.output,
  }));
  const reader = source.getReader();
  let i = 0;
  return new ReadableStream<AI.UIMessageChunk>({
    pull: async (controller) => {
      const next = preface[i];
      if (next !== undefined) {
        controller.enqueue(next);
        i++;
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel: (reason) => {
      reader.cancel(reason).catch(() => {
        /* swallow — best-effort upstream cancel */
      });
    },
  });
};
