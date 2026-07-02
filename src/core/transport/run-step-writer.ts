/**
 * The per-run step write path — the output-producing surface of an agent run
 * (`run.pipe` and `run.createStep`). Extracted from the session's run object so the
 * agent session COMPOSES it rather than embedding it, keeping `agent-session.ts`
 * focused on the run lifecycle (open / resolve / suspend / end) and channel
 * plumbing. Owns the per-run step bookkeeping (the default `stepId` index, the
 * previous step's id/reason for in-process retry coalescing, and the sticky
 * `stepClientId` cursor) and the shared pipe-to-channel path.
 *
 * The run object delegates `pipe`/`createStep` to the writer and supplies its
 * dependencies through {@link RunStepWriterContext}. The callback seams —
 * `assertPublishable` (the open/terminal gate) and `getAnchors` (the
 * late-resolved structural anchors) — let the run object own how a run opens and
 * resolves, so the writer stays agnostic of those policies. The writer never
 * ends the run: a cancelled pipe closes only its own step bracket, and the run
 * terminal is the run object's (`run.end()` / `session.end()`).
 */

import * as Ably from 'ably';

import { HEADER_START_SERIAL } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import { pipeStream } from './pipe-stream.js';
import type { RunManager, StepClientScopes } from './run-manager.js';
import type { DefaultTree } from './tree.js';
import type {
  PipeOptions,
  RunEndReason,
  RunRuntime,
  RunStep,
  StepEndParams,
  StepEndReason,
  StepOptions,
  StreamResult,
} from './types.js';

/**
 * Map a run's terminal {@link RunEndReason} to the {@link StepEndReason} an open
 * step settles with when the run ends (or a pipe finishes): a cancelled
 * run/pipe closes its step `cancelled`, an errored one `failed`, anything else
 * `complete`. The single source for this mapping, shared by run.pipe's implicit
 * close and the run object's run.end auto-close so the two cannot drift.
 * @param reason - The run/stream terminal reason.
 * @returns The matching step-end reason.
 */
export const stepEndReasonFor = (reason: RunEndReason): StepEndReason =>
  reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'failed' : 'complete';

/**
 * A mutable holder for a step attempt's `start-serial` (the channel serial of
 * its `ai-step-start`). The serial is known only AFTER the step-start publishes
 * — which for `run.pipe`'s lazy implicit step happens after the encoder is
 * already created — so the value is threaded through this ref rather than
 * captured up front: the composed encoder `onMessage` reads it live to stamp
 * every output, and the close reads it as the `ai-step-end` back-ref.
 */
interface StartSerialRef {
  /** The attempt's `start-serial`, or `undefined` until its `ai-step-start` publishes (or if that publish returned no serial). */
  value: string | undefined;
}

/**
 * The run's resolved structural anchors, read by every output publish. They are
 * resolved lazily when the run opens (undefined until then), so the writer reads
 * them live through {@link RunStepWriterContext.getAnchors} rather than capturing
 * them at construction.
 */
export interface StepWriterAnchors {
  /** The reply run's structural-parent fallback (its triggering input node), or undefined before the run resolves. */
  parentFallback: string | undefined;
  /** The run's `forkOf` anchor (an edit run's source), stamped on every output. */
  forkOf: string | undefined;
  /** The run's `msg-regenerate` anchor, echoed on every output so an early reader can populate the regenerate link. */
  regenerates: string | undefined;
  /** The triggering input's publisher client-id, re-stamped as `input-client-id` on the agent's own publishes. */
  inputClientId: string | undefined;
  /** The triggering input's codec-message-id, stamped as `input-codec-message-id`. */
  inputCodecMessageId: string | undefined;
}

/**
 * The dependencies the {@link RunStepWriter} needs from its owning agent run,
 * passed by the run object at construction. The callback seams
 * (`assertPublishable` / `getAnchors`) keep the run's open / resolve policy in
 * the run object while the writer owns the step + pipe mechanics.
 */
export interface RunStepWriterContext<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The run's id, read live (a continuation re-keys it as the run opens). */
  getRunId(): string;
  /** The run's invocation-id (stable), scoping the default `stepId` and stamped on every publish. */
  invocationId: string;
  /** The codec, used to create a per-stream encoder. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** The shared Ably channel the encoder publishes to. */
  channel: Ably.RealtimeChannel;
  /** The run manager, used to publish step lifecycle events and read the run owner's client-id. */
  runManager: RunManager;
  /** Live accessor for the session Tree (re-created on continuity loss), used to seed optimistic step lifecycle. */
  getTree: () => DefaultTree<TInput, TOutput, TProjection>;
  /** The run's runtime callbacks — `onMessage` (per published message), `onCancelled` (final write on cancel), `onError`. */
  runtime: RunRuntime<TOutput>;
  /** The run's composite abort signal (internal controller composed with any external signal). */
  signal: AbortSignal;
  /** The run's logger, if any. */
  logger: Logger | undefined;
  /** Await the channel being connected before a publish; rejects if the session is unusable. */
  requireConnected(method: string): Promise<void>;
  /**
   * Throw if the run is not open for publishing — and, for `step`, if it has
   * already ended. The run object owns the open/terminal policy; the writer only
   * gates on it.
   * @param verb - The calling verb, selecting the error message ('pipe' | 'step').
   */
  assertPublishable(verb: 'pipe' | 'step'): void;
  /** The run's resolved structural anchors, read live at publish time. */
  getAnchors(): StepWriterAnchors;
}

/** The output-producing surface of an agent run: stream piping and explicit step handles. */
export interface RunStepWriter<TOutput extends CodecOutputEvent> {
  /** Pipe a stream to the channel as the run's output (stepless). See {@link AgentRun.pipe}. */
  pipe: (stream: ReadableStream<TOutput>, streamOpts?: PipeOptions<TOutput>) => Promise<StreamResult>;
  /** Create an explicit step handle that brackets its output with `ai-step-start` / `ai-step-end`. See {@link AgentRun.createStep}. */
  createStep: (options?: StepOptions) => RunStep<TOutput>;
  /** True while a step is open (started, not ended) — for {@link AgentRun.suspend}'s reject-while-active guard. */
  hasActiveStep: () => boolean;
  /** Best-effort close the open step (if any) with `reason` — for {@link AgentRun.end}'s auto-close. Idempotent. */
  closeActiveStep: (reason: StepEndReason) => Promise<void>;
}

/**
 * Build the per-run step write path. Holds the run's step bookkeeping and returns
 * the `pipe` / `step` surface the run object delegates to.
 * @param ctx - The run's dependencies (see {@link RunStepWriterContext}).
 * @returns The run's {@link RunStepWriter}.
 */
export const createRunStepWriter = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  ctx: RunStepWriterContext<TInput, TOutput, TProjection, TMessage>,
): RunStepWriter<TOutput> => {
  const { codec, channel, runManager, getTree, signal, logger, invocationId } = ctx;
  const { onMessage, onCancelled, onError: runOnError } = ctx.runtime;

  // Per-run step bookkeeping for default `stepId` resolution (see step()):
  // a monotonic index for fresh steps, plus the previous step's id and
  // terminal reason so an in-process retry (a no-`stepId` call after a
  // `failed` step) coalesces onto that step rather than minting a new one.
  let stepIndex = 0;
  let lastStepId: string | undefined;
  let lastStepReason: StepEndReason | undefined;
  // The previous step's resolved `stepClientId`, the in-process fast-path for
  // the sticky-inheritance rung of the resolution ladder (see
  // resolveStepClientId). Set each time a step resolves its client.
  let lastStepClientId: string | undefined;

  // At most one step may be open on a run at a time. The handle has no lexical
  // bracket like the prior closure, so the writer tracks the open step
  // explicitly: run.end auto-closes it (closeActiveStep) and run.suspend rejects
  // while it is open (hasActiveStep). Holds the active step's settle fn, or
  // undefined when no step is open.
  let activeStep: { settle: (reason: StepEndReason) => Promise<void> } | undefined;
  // Set synchronously while a step is opening but `activeStep` is not yet
  // latched: start()'s mid-publish window, and a run.pipe's whole duration (its
  // implicit step opens lazily at first output, so there is no single publish to
  // bracket). Lets the guard reject a concurrent start()/pipe before the latch is
  // set, and is folded into hasActiveStep() so run.suspend rejects across that
  // window too.
  let opening = false;

  /**
   * Mint the next default in-process step id and advance the index. Scoped to
   * THIS invocation's id so steps from different invocations of the same run
   * (the original turn and a suspend/resume continuation) never collide and
   * supersede each other. Shared by createStep's default-id branch and
   * run.pipe's implicit step — each pipe mints its own id, so two pipes are two
   * independent steps (never a supersede).
   * @returns The fresh `${invocationId}-step-N` id.
   */
  const mintNextStepId = (): string => {
    const id = `${invocationId}-step-${String(stepIndex)}`;
    stepIndex++;
    return id;
  };

  /**
   * The invocation correlation + the three concentric client-identity scopes a
   * step's `ai-step-start` / `ai-step-end` carry. The outer two (`runClientId`,
   * `invocationClientId`) match the run's publishes; `stepClientId` is the step's
   * resolved client. `runClientId` is the run owner read live from the run
   * manager; `invocationClientId` rides the `input-client-id` wire name (the
   * triggering input's publisher).
   * @param stepClientId - The step's resolved client.
   * @returns The scopes object passed to the run manager's step publishes.
   */
  const stepScopes = (stepClientId: string): StepClientScopes => ({
    invocationId,
    runClientId: runManager.getClientId(ctx.getRunId()),
    invocationClientId: ctx.getAnchors().inputClientId,
    stepClientId,
  });

  /**
   * Re-derive the sticky `stepClientId` from the channel: the `step-client-id`
   * of the run's latest preceding step, read off the hydrated Tree (the same
   * channel-as-truth source `load()` / `adoptRun` use). The fast-path
   * {@link lastStepClientId} cursor is empty in a fresh adopting process whose
   * prior steps ran elsewhere, but that process's `load()`-hydrated Tree carries
   * those steps — so the sticky inheritance is authoritative from the channel,
   * not the (empty) cursor. Reads `StepInfo.stepClientId` of the most-recent step
   * that carries one (walking the read-model's first-observed order from the tail).
   * @returns The latest preceding step's client, or undefined when the run has no
   *   prior step on the channel yet (its first step).
   */
  const stepClientIdFromChannel = (): string | undefined => {
    const steps = getTree().getRunNode(ctx.getRunId())?.steps;
    if (!steps) return undefined;
    for (let i = steps.length - 1; i >= 0; i--) {
      const sc = steps[i]?.stepClientId;
      if (sc !== undefined && sc !== '') return sc;
    }
    return undefined;
  };

  /**
   * Resolve a step's `stepClientId` at `ai-step-start` (the precedence ladder,
   * parallel to the `stepId` ladder), and update the {@link lastStepClientId}
   * cursor:
   *   1. an explicit {@link StepOptions.stepClientId} (the steer seam populates) wins;
   *   2. else inherit the prior step's client — STICKY — from the in-process
   *      cursor (the provisioned/serverless fast-path), falling back to
   *      re-deriving it from the channel ({@link stepClientIdFromChannel}) so a
   *      fresh-process step with no cursor still inherits the run's prior step's
   *      client rather than resetting to the default;
   *   3. else (no prior step — the run's FIRST step) default to the triggering
   *      input's publisher (`input-client-id`), NOT the run owner: the two coincide
   *      on a fresh turn but diverge on a non-owner continuation, and the input's
   *      publisher is the correct lineage for the step that incorporates it.
   * @param explicit - The caller's explicit {@link StepOptions.stepClientId}, if any.
   * @returns The resolved step client (empty string when nothing resolves a value).
   */
  const resolveStepClientId = (explicit?: string): string => {
    const resolved = explicit ?? lastStepClientId ?? stepClientIdFromChannel() ?? ctx.getAnchors().inputClientId ?? '';
    lastStepClientId = resolved;
    return resolved;
  };

  /**
   * Publish `ai-step-start` and seed the optimistic step-start into the Tree
   * with the ACK serial the publish returns — the attempt's identity (its
   * `start-serial`). Shared by the eager open in createStep's start() and the
   * lazy first-output open in run.pipe. Stamps the step's invocation +
   * client-identity scopes (including the resolved `stepClientId`) on both the
   * wire event and the optimistic seed, and returns the start-serial so the
   * caller can back-reference it on the step's output and `ai-step-end`.
   * @param stepId - The step's id.
   * @param stepClientId - This step's resolved client (see resolveStepClientId).
   * @returns The `ai-step-start`'s channel serial (the `start-serial`), or
   *   `undefined` when the publish returned no serial.
   */
  const openStep = async (stepId: string, stepClientId: string): Promise<string | undefined> => {
    const runId = ctx.getRunId();
    const scopes = stepScopes(stepClientId);
    const startSerial = await runManager.startStep(runId, stepId, scopes);
    getTree().applyStepLifecycle({
      type: 'step-start',
      runId,
      stepId,
      invocationId,
      runClientId: scopes.runClientId ?? '',
      invocationClientId: scopes.invocationClientId ?? '',
      stepClientId,
      serial: startSerial,
    });
    return startSerial;
  };

  /**
   * Publish `ai-step-end`, seed the optimistic step-end into the Tree, and
   * record the step as the previous one so a following no-`stepId` retry can
   * coalesce. Shared by createStep and run.pipe's implicit step. Back-references
   * the attempt's `startSerial` and stamps the SAME `stepClientId` the matching
   * `ai-step-start` carried (passed in by the caller, not re-resolved) so a
   * step-end stays provably symmetric with its step-start.
   *
   * A `startSerial` of `undefined` means the matching `ai-step-start`'s publish
   * returned no serial, so the attempt has no wire identity to back-reference;
   * the step-end is skipped (it could not be attributed by a receiver anyway).
   * The previous-step bookkeeping still advances so retry coalescing is correct.
   * @param stepId - The step's id.
   * @param startSerial - The attempt's `start-serial` (its `ai-step-start`'s serial), or `undefined`.
   * @param reason - The step-end reason.
   * @param stepClientId - The step's resolved client (the value its matching `ai-step-start` was stamped with).
   */
  const closeStep = async (
    stepId: string,
    startSerial: string | undefined,
    reason: StepEndReason,
    stepClientId: string,
  ): Promise<void> => {
    const runId = ctx.getRunId();
    lastStepId = stepId;
    lastStepReason = reason;
    if (startSerial === undefined) {
      logger?.warn('Run.closeStep(); no start-serial for step, skipping step-end', { runId, stepId });
      return;
    }
    const scopes = stepScopes(stepClientId);
    await runManager.endStep(runId, stepId, startSerial, reason, scopes);
    getTree().applyStepLifecycle({
      type: 'step-end',
      runId,
      stepId,
      startSerial,
      invocationId,
      runClientId: scopes.runClientId ?? '',
      invocationClientId: scopes.invocationClientId ?? '',
      stepClientId,
      serial: undefined,
      reason,
    });
  };

  /**
   * Build the per-message encoder for one assistant-message publish under a
   * step. Each publish is its own message (a fresh `codecMessageId`), so
   * `pipe` and `send` both call this per invocation — the encoder itself is
   * short-lived, not a per-step long-lived object. Extracted so `doPipe` and
   * `doSend` share one path for header composition and the composed
   * `onMessage` that stamps the step attempt's `start-serial` (live via
   * {@link StartSerialRef} because the value is known only after
   * `ai-step-start` publishes, which for `run.pipe`'s lazy implicit step is
   * AFTER this encoder is created).
   * @param step - The step to stamp the message under.
   * @param step.stepId - The step's id, stamped on the message.
   * @param step.startSerialRef - Holds the step attempt's `start-serial`, stamped on the message once known.
   * @param step.stepClientId - The step's resolved client, stamped as `step-client-id`.
   * @param opts - Per-publish overrides.
   * @param opts.parent - Override for the assistant message's structural parent (from `PipeOptions.parent`).
   * @param opts.forkOf - Override for the assistant message's `forkOf` anchor (from `PipeOptions.forkOf`).
   * @returns The encoder (single message; caller must publish then `close()`).
   */
  const createMessageEncoder = (
    step: { stepId: string; startSerialRef: StartSerialRef; stepClientId: string },
    opts?: { parent?: string; forkOf?: string },
  ) => {
    const runId = ctx.getRunId();
    const anchors = ctx.getAnchors();
    const runOwnerClientId = runManager.getClientId(runId);

    const codecMessageId = crypto.randomUUID();
    // The default headers carry no attempt identity: `start-serial` is known
    // only after the step-start publishes (for the lazy implicit step, inside
    // `onFirstOutput` — after this encoder is created), so it is injected
    // per-message by the composed `onMessage` rather than baked in here.
    const defaultHeaders = buildTransportHeaders({
      role: 'assistant',
      runId,
      codecMessageId,
      runClientId: runOwnerClientId,
      // The assistant message's parent: an explicit per-publish override from
      // the caller, else the reply run's structural-parent fallback computed
      // once at run-start (`parentFallback`). Owning the default here means
      // agent routes don't have to thread the parent to keep tree threading
      // correct.
      parent: opts?.parent ?? anchors.parentFallback,
      forkOf: opts?.forkOf ?? anchors.forkOf,
      invocationId,
      inputClientId: anchors.inputClientId,
      inputCodecMessageId: anchors.inputCodecMessageId,
      // Echo `msg-regenerate` on the assistant message so a client receiving
      // the assistant chunk before `ai-run-start` can still populate
      // `RunNode.regeneratesCodecMessageId` from headers.
      regenerates: anchors.regenerates,
      stepId: step.stepId,
      stepClientId: step.stepClientId,
    });
    // Compose the encoder's `onMessage`: stamp the step attempt's `start-serial`
    // (once known) on the transport tier of every outbound message, THEN run the
    // developer's hook. Reads the ref live so it captures the value the lazy
    // implicit-step open sets before the first output is published.
    const stampStartSerial = (message: Ably.Message): void => {
      const startSerial = step.startSerialRef.value;
      if (startSerial === undefined) return;
      // CAST: the encoder always builds `extras.ai.transport` before invoking
      // this hook (Ably SDK types `extras` as `any`); narrow to the tier we own.
      const transport = (message.extras as { ai: { transport: Record<string, string> } }).ai.transport;
      transport[HEADER_START_SERIAL] = startSerial;
    };
    return codec.createEncoder(channel, {
      extras: { headers: defaultHeaders },
      onMessage: (message: Ably.Message): void => {
        stampStartSerial(message);
        onMessage?.(message);
      },
      messageId: codecMessageId,
    });
  };

  /**
   * Pipe a stream through a fresh encoder to the channel, always within a step
   * bracket. Shared by {@link RunStepWriter.pipe} (an implicit step opened
   * LAZILY at first output via `step.onFirstOutput`) and {@link RunStep.pipe}
   * (an explicit step the caller already opened eagerly, so it omits
   * `onFirstOutput`). It does NOT end the run on cancel — the run terminal is
   * the outer layer's responsibility (`run.end()`, or `session.end()` for an
   * open run at teardown); a cancelled pipe closes only its own step bracket
   * (the caller's close-iff-opened / `step.end()`).
   * @param stream - The output stream to pipe.
   * @param streamOpts - Per-stream overrides.
   * @param step - The step to stamp output under.
   * @param step.stepId - The step's id, stamped on every output.
   * @param step.startSerialRef - Holds the step attempt's `start-serial`, stamped on every output once known.
   * @param step.stepClientId - The step's resolved client, stamped as `step-client-id` on every output.
   * @param step.onFirstOutput - Optional hook fired once before the first output (the lazy implicit-step open); omitted when the step is already open.
   * @returns The {@link StreamResult}.
   */
  const doPipe = async (
    stream: ReadableStream<TOutput>,
    streamOpts: PipeOptions<TOutput> | undefined,
    step: {
      stepId: string;
      startSerialRef: StartSerialRef;
      stepClientId: string;
      onFirstOutput?: () => Promise<void>;
    },
  ): Promise<StreamResult> => {
    await ctx.requireConnected('pipe');
    ctx.assertPublishable('pipe');

    const runId = ctx.getRunId();
    const encoder = createMessageEncoder(step, { parent: streamOpts?.parent, forkOf: streamOpts?.forkOf });

    const result = await pipeStream(
      stream,
      encoder,
      signal,
      onCancelled,
      streamOpts?.resolveWriteOptions,
      logger,
      step.onFirstOutput,
    );

    if (result.error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to pipe response for run ${runId}; ${result.error.message}`,
        ErrorCode.StreamError,
        500,
        errorCause(result.error),
      );
      logger?.error('Run.pipe(); stream error', { runId });
      runOnError?.(errInfo);
    }

    logger?.debug('Run.pipe(); stream finished', { runId, reason: result.reason });
    return result;
  };

  /**
   * Publish a single discrete output as one assistant message. Reuses the same
   * per-message encoder path as {@link doPipe} but skips the pipe-stream loop
   * — there is no stream to iterate, no cancellation-race machinery, and no
   * `resolveWriteOptions` per-output hook (a single call would use it at most
   * once).
   * @param output - The single codec output to publish.
   * @param step - The step to stamp output under.
   * @param step.stepId - The step's id, stamped on the output.
   * @param step.startSerialRef - Holds the step attempt's `start-serial`, stamped on the output.
   * @param step.stepClientId - The step's resolved client, stamped as `step-client-id`.
   */
  const doSend = async (
    output: TOutput,
    step: { stepId: string; startSerialRef: StartSerialRef; stepClientId: string },
  ): Promise<void> => {
    await ctx.requireConnected('send');
    ctx.assertPublishable('pipe');

    const encoder = createMessageEncoder(step);

    try {
      await encoder.publishOutput(output);
    } finally {
      await encoder.close();
    }

    logger?.debug('RunStep.send(); output sent', { runId: ctx.getRunId(), stepId: step.stepId });
  };

  // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6c
  const pipe = async (stream: ReadableStream<TOutput>, streamOpts?: PipeOptions<TOutput>): Promise<StreamResult> => {
    const runId = ctx.getRunId();
    logger?.trace('Run.pipe();', { runId });

    // run.pipe respects the one-active-step latch: an explicit step open on this
    // run must be ended first.
    if (activeStep !== undefined || opening) {
      throw new Ably.ErrorInfo(
        'unable to pipe; a step is already active on this run (end it first)',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    // Latch synchronously BEFORE any await — exactly as start() does — so a
    // second concurrent run.pipe (or a createStep().start()) hits the guard
    // above and is rejected before this pipe's implicit step opens lazily at
    // first output. Held for the pipe's whole duration (cleared in `finally`):
    // the step may never open (a pipe producing nothing brackets ZERO steps),
    // yet a concurrent step must still be blocked while the pipe runs.
    opening = true;
    try {
      // run.pipe brackets its output in an implicit step, opened LAZILY at the
      // first output chunk so a pipe that produces nothing (empty / errored /
      // cancelled before any chunk) brackets ZERO steps. A fresh default id per
      // pipe (no coalescing) makes two pipes two independent steps. The implicit
      // step joins the activeStep latch like an explicit one, so run.suspend
      // rejects and run.end auto-closes while it is open.
      const stepId = mintNextStepId();
      // The implicit step has no explicit client; resolve it via the ladder
      // (sticky from the cursor, else the triggering input's publisher on the
      // run's first step). Resolved eagerly — even though the step opens lazily —
      // so the cursor advances consistently and the value stamps every output.
      const stepClientId = resolveStepClientId();
      // Holds the attempt's `start-serial` once the lazy open publishes its
      // `ai-step-start`. The composed encoder `onMessage` reads it to stamp
      // every output, and the close uses it as the `ai-step-end` back-ref.
      const startSerialRef: StartSerialRef = { value: undefined };
      // Object wrapper, not bare `let`s: TS would flow-narrow `opened` (assigned
      // only inside the onFirstOutput callback) to false at the close check below.
      const stepState = { opened: false, settled: false };

      // Idempotent close that clears the latch if this step holds it, so
      // run.end's auto-close (run.end -> closeActiveStep, e.g. from session.end)
      // and the close-iff-opened below never double-publish `ai-step-end`.
      const settle = async (reason: StepEndReason): Promise<void> => {
        if (stepState.settled) return;
        stepState.settled = true;
        if (activeStep?.settle === settle) activeStep = undefined;
        await closeStep(stepId, startSerialRef.value, reason, stepClientId);
      };

      const result = await doPipe(stream, streamOpts, {
        stepId,
        startSerialRef,
        stepClientId,
        onFirstOutput: async () => {
          stepState.opened = true;
          activeStep = { settle };
          startSerialRef.value = await openStep(stepId, stepClientId);
        },
      });

      // Close the implicit step iff it opened: a cancel closes it `cancelled`, a
      // stream error `failed`, anything else `complete`. Idempotent, so if
      // run.end (or session.end) already auto-closed this step via
      // closeActiveStep (the same reason mapping) this is a no-op.
      if (stepState.opened) {
        // Best-effort, like the explicit step's close: a fire-and-forget run.pipe
        // whose connection closed mid-stream must not escape an unhandled rejection
        // from the step-end publish. The run-level terminal is the authority for run
        // completion; a missing step-end on a dying connection is non-impactful.
        try {
          await settle(stepEndReasonFor(result.reason));
        } catch {
          logger?.error('Run.pipe(); failed to close implicit step', { runId, stepId });
        }
      }
      return result;
    } finally {
      opening = false;
    }
  };

  const createStep = (options?: StepOptions): RunStep<TOutput> => {
    const runId = ctx.getRunId();
    logger?.trace('Run.createStep();', { runId });

    // Resolve the step id SYNCHRONOUSLY (createStep does no I/O — only start()
    // publishes; see StepOptions.stepId / the Run.createStep contract): an
    // explicit id wins; else reuse the previous step's id if it failed
    // (in-process retry coalescing); else mint the next index. The default is
    // scoped to THIS invocation's id so steps from different invocations of the
    // same run (e.g. the original turn and a suspend/resume continuation) never
    // collide and supersede each other — only an explicit, stable `stepId`
    // coalesces across invocations. A fresh attempt id is always minted.
    let stepId: string;
    if (options?.stepId !== undefined) {
      stepId = options.stepId;
    } else if (lastStepReason === 'failed' && lastStepId !== undefined) {
      stepId = lastStepId;
    } else {
      stepId = mintNextStepId();
    }
    // Holds the attempt's `start-serial` once start() publishes its
    // `ai-step-start`. The composed encoder `onMessage` reads it to stamp every
    // output, and the close uses it as the `ai-step-end` back-ref.
    const startSerialRef: StartSerialRef = { value: undefined };
    // Step client: an explicit `options.stepClientId` (the steer seam) wins;
    // else sticky from the cursor; else the triggering input's publisher on the
    // run's first step (see resolveStepClientId). Stamped on the bracket + output.
    const stepClientId = resolveStepClientId(options?.stepClientId);

    // Step state machine: 'initialized' (minted, not started) -> 'active'
    // (ai-step-start published) -> 'settled' (ai-step-end published). Gates
    // pipe-before-start, double-start, and double-end. Object wrapper so TS
    // doesn't flow-narrow away the `errored`/`cancelled` mutations pipe() makes.
    let state: 'initialized' | 'active' | 'settled' = 'initialized';
    const pipeState = { errored: false, cancelled: false };

    // Close the step exactly once, clearing the active-step latch if this step
    // holds it. Idempotent, so end()-after-end() and run.end's auto-close after
    // an explicit end() are both no-ops.
    const settle = async (reason: StepEndReason): Promise<void> => {
      if (state === 'settled') return;
      state = 'settled';
      if (activeStep?.settle === settle) activeStep = undefined;
      await closeStep(stepId, startSerialRef.value, reason, stepClientId);
      logger?.debug('RunStep.end(); step closed', { runId, stepId, reason });
    };

    return {
      get stepId() {
        return stepId;
      },
      get abortSignal() {
        return signal;
      },
      start: async (): Promise<void> => {
        logger?.trace('RunStep.start();', { runId, stepId });
        if (state !== 'initialized') return; // idempotent: already started or settled
        if (activeStep !== undefined || opening) {
          throw new Ably.ErrorInfo(
            'unable to start step; another step is already active on this run',
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // Latch synchronously BEFORE any await (the `opening` flag) so a
        // concurrent start() cannot also pass the guard above. The active-step
        // latch is set only once the publish succeeds, so a failed open leaves
        // the run with no phantom active step for run.end / run.suspend to trip
        // over.
        opening = true;
        try {
          await ctx.requireConnected('step');
          ctx.assertPublishable('step');
          startSerialRef.value = await openStep(stepId, stepClientId);
          state = 'active';
          activeStep = { settle };
        } finally {
          opening = false;
        }
      },
      pipe: async (stream: ReadableStream<TOutput>, streamOpts?: PipeOptions<TOutput>): Promise<StreamResult> => {
        if (state !== 'active') {
          throw new Ably.ErrorInfo(
            'unable to pipe step; the step is not active — call start() first and do not pipe after end()',
            ErrorCode.InvalidArgument,
            400,
          );
        }
        const result = await doPipe(stream, streamOpts, { stepId, startSerialRef, stepClientId });
        // A piped stream error marks the step failed without throwing — so the
        // common `vercelRunOutcome(...) -> run.end(outcome)` flow needs no
        // try/catch, while the step status still reflects the failure.
        if (result.reason === 'error') pipeState.errored = true;
        // A cancel marks it cancelled so an explicit end() still closes the step
        // `cancelled` rather than the derived `complete`.
        if (result.reason === 'cancelled') pipeState.cancelled = true;
        return result;
      },
      send: async (output: TOutput): Promise<void> => {
        if (state !== 'active') {
          throw new Ably.ErrorInfo(
            'unable to send step; the step is not active — call start() first and do not send after end()',
            ErrorCode.InvalidArgument,
            400,
          );
        }
        try {
          await doSend(output, { stepId, startSerialRef, stepClientId });
        } catch (error) {
          // A publish throw marks the step failed so a subsequent `end()` with
          // no reason still settles `failed` (mirrors pipe's error-tracking) —
          // callers that catch the throw and then call end() get consistent
          // step-terminal semantics.
          pipeState.errored = true;
          throw error;
        }
      },
      end: async (params?: StepEndParams): Promise<void> => {
        // Derive the reason from piped output when not given, so a step closed
        // after a stream error settles `failed` with no explicit bookkeeping. A
        // cancel settles `cancelled` — whether the cancelled pipe marked it, or
        // the run's signal aborted with no (or before any) output, so a step
        // cancelled before piping still closes `cancelled`.
        const cancelled = pipeState.cancelled || signal.aborted;
        await settle(params?.reason ?? (cancelled ? 'cancelled' : pipeState.errored ? 'failed' : 'complete'));
      },
    };
  };

  // True while a step is open OR opening (the synchronous pre-latch window of
  // start() / run.pipe), so run.suspend rejects for the whole step-active span,
  // not only after `activeStep` latches.
  const hasActiveStep = (): boolean => activeStep !== undefined || opening;

  const closeActiveStep = async (reason: StepEndReason): Promise<void> => {
    // Best-effort: end any open step before the run terminates so it never
    // dangles. The run object calls this from run.end — the handle has no
    // lexical finally to guarantee closure on every exit path.
    await activeStep?.settle(reason);
  };

  return { pipe, createStep, hasActiveStep, closeActiveStep };
};
