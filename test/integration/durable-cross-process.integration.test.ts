/**
 * Durable cross-process integration matrix.
 *
 * The framework-free proof that the durable spine composes ACROSS PROCESSES over
 * real Ably, driven entirely through the RAW SDK primitives (no durable helper).
 * Each test is an in-process "workflow driver": the test body holds the run's
 * identity (`{ runId, invocationId }`) and calls small TEST-LOCAL activity
 * drivers (`openActivity` / `stepActivity` / `suspendActivity` / `endActivity` /
 * `cancelActivity`) across SEPARATE sessions. Every driver call mints a FRESH
 * client via `ablyRealtimeClient()`, builds a fresh `createAgentSession`,
 * connects, does its work, and closes both in a `finally` - so each activity is a
 * fresh process exactly as a durable workflow would run it. The drivers wrap only
 * the PUBLIC primitives (`session.createRun().start()`,
 * `session.adoptRun(identity).load()`, `run.createStep({ stepId })`,
 * `run.suspend()`, `run.end()`), with the same identity binding a durable
 * orchestrator would apply. There is no durable flag and no attempt id: a stable
 * `stepId` is what makes a cross-process retry supersede (its re-emitted
 * `ai-step-start` carries a later serial), and the in-flight cancel arm hands a
 * run off via `session.close()` while a separate cleanup activity publishes the
 * terminal. A separate observer client verifies the wire, and a fresh
 * `ClientSession` hydrates a Tree from channel history to prove channel-as-truth
 * reconstruction.
 *
 * This proves what no single-process unit test can stage: that the SDK primitives
 * compose cross-process over real Ably AND that the identities bind correctly. It
 * does NOT re-prove the per-op transport contracts (those stay unit-level) or the
 * window-dependent receiver hazards (deterministically covered by the unit
 * `tree.test.ts` with a shrunk `reorderWindowMs` + synthetic clock; over real
 * Ably they are arrival-order-non-deterministic, so they stay unit-level). The
 * runnable durable reference demo is a separate runnable app and is out of scope
 * here.
 *
 * No LLM: a fixture `streamText`-shaped result wraps a deterministic
 * UIMessageChunk stream. Tests run SEQUENTIALLY on one shared channel each;
 * clients are closed in `afterEach`.
 */

import '../helper/expectations.js';

import * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EVENT_AI_OUTPUT,
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEP_CLIENT_ID,
  HEADER_STEP_ID,
  HEADER_STEP_REASON,
} from '../../src/constants.js';
import { toCodecEvents } from '../../src/core/codec/codec-event.js';
import { createAgentSession } from '../../src/core/transport/agent-session.js';
import { createClientSession } from '../../src/core/transport/client-session.js';
import { buildTransportHeaders } from '../../src/core/transport/headers.js';
import { Invocation } from '../../src/core/transport/invocation.js';
import type {
  AdoptedRun,
  AgentSession,
  ClientSession,
  RunEndParams,
  StreamResult,
} from '../../src/core/transport/types.js';
import { getCodecHeaders, getTransportHeaders } from '../../src/utils.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../src/vercel/codec/index.js';
import { UIMessageCodec } from '../../src/vercel/codec/index.js';
import { type VercelRunOutcome, vercelRunOutcome } from '../../src/vercel/run-end-reason.js';
import { uniqueChannelName } from '../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../helper/realtime-client.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type ClientSessionT = ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
type AgentSessionT = AgentSession<VercelOutput, VercelProjection, AI.UIMessage>;
type AdoptedRunT = AdoptedRun<VercelOutput, VercelProjection, AI.UIMessage>;

/** The two ids the open activity mints and the driver threads to every later activity of the turn. */
interface TurnIds {
  /** The run's id, minted by `createRun` + `start()` in {@link openActivity}. */
  runId: string;
  /** This turn's invocation id, stamped on every event the turn publishes. */
  invocationId: string;
}

/**
 * The identity a fresh-process adopting activity threads: the {@link TurnIds}
 * plus the invocation (for the channel/session name) and the trigger event whose
 * headers resolve the run's write anchors. Mirrors the SDK's `AdoptIdentity`,
 * adding the invocation the driver needs to build the session.
 */
interface AdoptArgs extends TurnIds {
  /** The invocation carrying the session (channel) name. */
  invocation: Invocation;
  /**
   * The id of the event whose headers resolve the run's anchors. An `ai-input`
   * for a step/end/suspend; the `ai-cancel` event for a cancel cleanup.
   */
  triggerEventId: string;
}

/** The framework's stable step identity, threaded to {@link stepActivity}. */
interface StepMeta {
  /** The framework's stable step id - stable across retries of the same logical step, so a retry supersedes by serial. */
  stepId: string;
}

// Merged view of the transport + codec header tiers (disjoint keys), so an
// assertion can read either tier by bare key.
const headersOf = (msg: Ably.InboundMessage): Record<string, string> => ({
  ...getTransportHeaders(msg),
  ...getCodecHeaders(msg),
});

// ---------------------------------------------------------------------------
// The fixture stream (no LLM)
// ---------------------------------------------------------------------------

/**
 * A fixture `streamText`-shaped result wrapping a deterministic UIMessageChunk
 * stream - the `{ toUIMessageStream(); finishReason }` shape a step's `produce`
 * returns. Stands in for a real `streamText({...})` so the matrix needs no LLM.
 * `finishReason: 'tool-calls'` drives a suspend; `'stop'` drives complete.
 * @param text - The assistant text to stream (split into two deltas).
 * @param finishReason - The Vercel finish reason (`'stop'` = complete, `'tool-calls'` = suspend).
 * @param ids - The message + text part ids (so distinct steps carry distinct message ids); minted when omitted.
 * @param ids.messageId - The assistant message id the stream opens.
 * @param ids.textId - The text part id the stream's deltas carry.
 * @returns A fixture stream result the step driver brackets.
 */
const fixtureResult = (
  text: string,
  finishReason: AI.FinishReason = 'stop',
  ids?: { messageId: string; textId: string },
): VercelStreamResult => {
  const messageId = ids?.messageId ?? crypto.randomUUID();
  const textId = ids?.textId ?? crypto.randomUUID();
  return {
    toUIMessageStream: (): ReadableStream<VercelOutput> => {
      const mid = Math.floor(text.length / 2);
      return new ReadableStream<VercelOutput>({
        start: (controller) => {
          controller.enqueue({ type: 'start', messageId });
          controller.enqueue({ type: 'start-step' });
          controller.enqueue({ type: 'text-start', id: textId });
          controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(0, mid) });
          controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(mid) });
          controller.enqueue({ type: 'text-end', id: textId });
          controller.enqueue({ type: 'finish', finishReason });
          controller.close();
        },
      });
    },
    finishReason: Promise.resolve(finishReason),
  };
};

/**
 * A fixture result whose stream errors after one chunk - drives the step
 * driver's bracket to `reason: 'error'`, so the driver THROWS for the framework
 * to retry.
 * @returns A fixture stream result whose stream errors.
 */
const erroringResult = (): VercelStreamResult => ({
  toUIMessageStream: (): ReadableStream<VercelOutput> =>
    new ReadableStream<VercelOutput>({
      start: (controller) => {
        controller.enqueue({ type: 'start', messageId: crypto.randomUUID() });
        controller.enqueue({ type: 'start-step' });
        controller.enqueue({ type: 'text-start', id: 't-err' });
        controller.enqueue({ type: 'text-delta', id: 't-err', delta: 'partial...' });
        controller.error(new Error('model rate limit exceeded'));
      },
    }),
  finishReason: Promise.resolve('error'),
});

// ---------------------------------------------------------------------------
// The workflow driver harness (raw primitives)
// ---------------------------------------------------------------------------

/**
 * What a step driver's `produce` closure returns: a `streamText`-shaped result.
 * The driver pipes {@link VercelStreamResult.toUIMessageStream} through the
 * step, then maps the outcome via {@link vercelRunOutcome} (reading
 * {@link VercelStreamResult.finishReason} to tell suspend from complete).
 */
interface VercelStreamResult {
  /** The Vercel UI-message chunk stream for this response, piped through the step. */
  toUIMessageStream: () => ReadableStream<VercelOutput>;
  /** Vercel's finish reason - `'tool-calls'` suspends, otherwise the step completes. */
  finishReason: PromiseLike<AI.FinishReason>;
}

/** Per-activity options: the channel, plus an optional in-flight abort signal and reusable client. */
interface ActivityOptions {
  /** The shared session channel the activity attaches. */
  channelName: string;
  /**
   * An external AbortSignal forwarded to the run's runtime, cancelling it while
   * in flight. Omit for an activity that runs to natural completion.
   */
  signal?: AbortSignal;
  /**
   * An existing client to reuse instead of minting a fresh one. When supplied the
   * driver does NOT close it (the caller owns its lifecycle); used to stage a
   * mid-step process death by closing the shared client externally.
   */
  client?: Ably.Realtime;
}

/**
 * Build + connect a fresh-client agent session, run `body` against it, and close
 * BOTH the session and the client in a `finally` - UNLESS the caller supplied
 * their own `client` (then the caller owns close). A fresh client per activity is
 * a fresh "process", exactly how a durable workflow invokes each activity.
 * @template T - The body's return type.
 * @param opts - The activity options (channel + optional signal + optional reused client).
 * @param body - Runs against the connected session; its value is returned.
 * @returns Whatever `body` resolves to.
 */
const withSession = async <T>(opts: ActivityOptions, body: (session: AgentSessionT) => Promise<T>): Promise<T> => {
  const ownsClient = opts.client === undefined;
  const client = opts.client ?? ablyRealtimeClient();
  const session = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
    client,
    channelName: opts.channelName,
    codec: UIMessageCodec,
  });
  try {
    await session.connect();
    return await body(session);
  } finally {
    // Close the session, then the client. The client close is its OWN finally so
    // it runs even if `session.close()` rejects. Only close the client this
    // activity minted; a caller-supplied client is the caller's to close (the
    // registered cleanup in `afterEach` closes any leftover).
    try {
      await session.close();
    } finally {
      if (ownsClient) client.close();
    }
  }
};

/**
 * Page `run.view.loadOlder()` until the run's trigger folds in and `run.located`
 * resolves (the cold-start path: a trigger published before this process
 * attached sits in history, and the watcher never pages itself). Races each page
 * against `run.located` so it stops the instant the trigger surfaces, and gives
 * up when history is exhausted (then awaits `located` to surface any rejection).
 * @param run - The freshly created run whose trigger sits in channel history.
 * @returns Resolves once `run.located` has settled (or history is exhausted).
 */
const pageUntilLocated = async (run: AdoptedRunT | ReturnType<AgentSessionT['createRun']>): Promise<void> => {
  // Tag the located promise so the race can tell a resolve from a still-pending
  // page; a rejection (cancel / close) propagates out of the await at the end.
  // Object wrapper so the loop condition is not flow-narrowed to its initial
  // value (the flag is mutated only inside the async settle callbacks below).
  const state = { located: false };
  const locatedTag = run.located.then(
    () => {
      state.located = true;
    },
    () => {
      state.located = true;
    },
  );
  for (let i = 0; i < 20 && !state.located && run.view.hasOlder(); i++) {
    await Promise.race([run.view.loadOlder(100), locatedTag]);
  }
  // Surface a located rejection (cancel / session close) if there was one.
  await run.located;
};

/**
 * OPEN (and RESUME) a run from a fresh process: `createRun(invocation) +
 * start()`, returning the ids the driver threads to every later activity.
 * `start()` distinguishes a fresh open (`ai-run-start`) from a resume
 * (`ai-run-resume`) by the trigger event's run-id header, so this ONE driver
 * serves both roles.
 *
 * The triggering input was published out-of-band BEFORE this fresh process
 * attached, so it sits in channel history rather than the live stream. The
 * input-event watcher is passive (it never pages itself), so this driver pages
 * `run.view.loadOlder()` until `run.located` resolves — the cold-start path the
 * `located` contract documents — before awaiting `start()`.
 * @param invocation - The invocation that triggered this open.
 * @param opts - The activity options (channel + optional signal).
 * @returns The minted {@link TurnIds}.
 */
const openActivity = async (invocation: Invocation, opts: ActivityOptions): Promise<TurnIds> =>
  withSession(opts, async (session) => {
    const run = session.createRun(invocation, { ...(opts.signal !== undefined && { signal: opts.signal }) });
    await pageUntilLocated(run);
    await run.start();
    return { runId: run.runId, invocationId: run.invocationId };
  });

/**
 * Run an adopting activity's body against a freshly built + connected session:
 * `adoptRun() + load()`, run `body(run)`, close both in a `finally`. There is no
 * durable flag: the durable behaviour is a USAGE PATTERN — a step/end activity
 * adopts + loads, and the in-flight arm hands off via `session.close()` (no
 * terminal) while a separate cleanup activity publishes the run terminal. The
 * owner the adopt seeds off the channel makes output AND the terminal stamp the
 * real `run-client-id`.
 * @template T - The body's return type.
 * @param args - The {@link AdoptArgs} identifying the open run + its trigger.
 * @param opts - The activity options (channel + optional signal + optional reused client).
 * @param body - Runs against the adopted, loaded run; its value is returned.
 * @returns Whatever `body` resolves to.
 */
const runAdoptedActivity = async <T>(
  args: AdoptArgs,
  opts: ActivityOptions,
  body: (run: AdoptedRunT) => Promise<T>,
): Promise<T> =>
  withSession(opts, async (session) => {
    const run = session.adoptRun(
      { runId: args.runId, invocationId: args.invocationId, triggerEventId: args.triggerEventId },
      { ...(opts.signal !== undefined && { signal: opts.signal }) },
    );
    // No caller pre-paging: load() is self-contained — its visibility-wait pages
    // channel history until BOTH the run-start and the (older) trigger have
    // folded, so a fresh process adopts correctly even when the trigger and the
    // run-start straddle a history page. The bound fails a missing run-start fast
    // rather than hanging the default 30s.
    await run.load({ timeoutMs: 15_000 });
    return body(run);
  });

/**
 * Run ONE step of an open run from a fresh process: adopt + load, then
 * `run.createStep({ stepId })` where the step pipes the produced stream and maps
 * the result via {@link vercelRunOutcome}. The stable `stepId` is what makes a
 * cross-process retry supersede cleanly — a fresh attempt re-emits its
 * `ai-step-start` under the same `stepId` (a new channel serial), so the
 * latest-serial start is canonical and the dead attempt's output is gated out.
 * THROWS on a stream error (`reason === 'error'`) so the framework retries the
 * step; RETURNS the {@link VercelRunOutcome} for a `'suspend'` / `'complete'` /
 * `'cancelled'` outcome - the run terminal is the driver's to publish from a
 * {@link suspendActivity} / {@link endActivity}.
 * @param args - The {@link AdoptArgs} identifying the open run + its trigger.
 * @param opts - The activity options (channel + optional signal + optional reused client).
 * @param produce - Builds the step's `streamText`-shaped result from the adopted run.
 * @param stepMeta - The framework's stable step identity ({@link StepMeta}).
 * @returns The successful {@link VercelRunOutcome}.
 */
const stepActivity = async (
  args: AdoptArgs,
  opts: ActivityOptions,
  produce: (run: AdoptedRunT) => VercelStreamResult | Promise<VercelStreamResult>,
  stepMeta: StepMeta,
): Promise<VercelRunOutcome> =>
  runAdoptedActivity(args, opts, async (run) => {
    const step = run.createStep({ stepId: stepMeta.stepId });
    await step.start();
    const result = await produce(run);
    const pipeResult: StreamResult = await step.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    // A step failure closes the step `failed` and throws so the durable
    // framework retries; the stable stepId makes the retry supersede and the
    // error propagates as-is. A 'suspend' / non-error terminal closes the step
    // (the reason derived from the pipe) and is RETURNED.
    if (outcome.reason === 'error') {
      await step.end({ reason: 'failed' });
      throw outcome.error;
    }
    await step.end();
    return outcome;
  });

/**
 * SUSPEND an open run from a fresh process: adopt + load + `run.suspend()`.
 * @param args - The {@link AdoptArgs} identifying the open run + its trigger.
 * @param opts - The activity options (channel).
 * @returns Resolves once the suspend is published and the session has closed.
 */
const suspendActivity = async (args: AdoptArgs, opts: ActivityOptions): Promise<void> =>
  runAdoptedActivity(args, opts, async (run) => {
    await run.suspend();
  });

/**
 * END an open run from a fresh process: adopt + load + `run.end(outcome)`. The
 * owner the adopt seeds off the channel makes the terminal stamp the real
 * `run-client-id` even though this process never opened the run.
 * @param args - The {@link AdoptArgs} identifying the open run + its trigger.
 * @param opts - The activity options (channel).
 * @param outcome - How the run ends; see {@link RunEndParams}.
 * @returns Resolves once the terminal is published and the session has closed.
 */
const endActivity = async (args: AdoptArgs, opts: ActivityOptions, outcome: RunEndParams): Promise<void> =>
  runAdoptedActivity(args, opts, async (run) => {
    await run.end(outcome);
  });

/**
 * The driver's CANCEL cleanup arm: adopt + load + `run.end({ reason: 'cancelled' })`.
 * The in-flight step arm hands off via `session.close()` (pipe never auto-ends),
 * so this cleanup activity is the sole publisher of `ai-run-end{cancelled}`. The
 * {@link AdoptArgs} carries the cancel POST's own invocation id and the
 * `ai-cancel` event id as the trigger - formed via {@link adoptArgsFromCancel}.
 * @param args - The {@link AdoptArgs} with the cancel invocation id + the `ai-cancel` trigger event id.
 * @param opts - The activity options (channel).
 * @returns Resolves once `ai-run-end{cancelled}` is published and the session has closed.
 */
const cancelActivity = async (args: AdoptArgs, opts: ActivityOptions): Promise<void> =>
  runAdoptedActivity(args, opts, async (run) => {
    await run.end({ reason: 'cancelled' });
  });

/**
 * Publish a real triggering `ai-input` on the channel from a publisher client,
 * exactly as a `ClientSession.send()` would, and return the invocation pointer +
 * the input event id the open activity resolves against. The driver publishes the
 * input out-of-band (the activities own only the agent side), so the open
 * activity can locate it via the channel.
 * @param channelName - The shared session channel.
 * @param publisher - The Ably client that publishes the input (its clientId becomes the input publisher).
 * @param opts - The user text + codec-message-id + optional reused run-id (a continuation).
 * @param opts.text - The user message text to publish.
 * @param opts.codecMessageId - The codec-message-id for the input node.
 * @param opts.runId - When set, stamps the reused run-id on the wire so the open
 *   activity resolves a continuation (publishes `ai-run-resume`).
 * @returns The invocation + the input event id.
 */
const publishInput = async (
  channelName: string,
  publisher: Ably.Realtime,
  opts: { text: string; codecMessageId: string; runId?: string },
): Promise<{ invocation: Invocation; inputEventId: string }> => {
  const inputEventId = crypto.randomUUID();
  const channel = publisher.channels.get(channelName);
  const headers = buildTransportHeaders({
    role: 'user',
    ...(opts.runId !== undefined && { runId: opts.runId }),
    codecMessageId: opts.codecMessageId,
    inputEventId,
  });
  const encoder = UIMessageCodec.createEncoder(channel, { extras: { headers } });
  await encoder.publishInput(
    UIMessageCodec.createUserMessage({
      id: opts.codecMessageId,
      role: 'user',
      parts: [{ type: 'text', text: opts.text }],
    }),
  );
  return { invocation: Invocation.fromJSON({ inputEventId, sessionName: channelName }), inputEventId };
};

/**
 * Build the {@link AdoptArgs} the step / end / suspend activities thread.
 * @param ids - The run + invocation ids opened by {@link openActivity}.
 * @param invocation - The invocation carrying the session (channel) name.
 * @param triggerEventId - The trigger event the adopt resolves anchors against.
 * @returns The {@link AdoptArgs} for an adopting activity.
 */
const adoptArgs = (ids: TurnIds, invocation: Invocation, triggerEventId: string): AdoptArgs => ({
  runId: ids.runId,
  invocationId: ids.invocationId,
  invocation,
  triggerEventId,
});

/**
 * Form the {@link AdoptArgs} for {@link cancelActivity} from the cancel POST's
 * ids: the cleanup arm resolves its anchors against the `ai-cancel` event (not
 * the original input) and stamps the cancel POST's own invocation id
 * (`I_cancel`).
 * @param turnIds - The cancelled run's id + the cancel POST's invocation id (`I_cancel`).
 * @param invocation - The invocation carrying the session (channel) name.
 * @param cancelEventId - The `ai-cancel` event's id (the trigger the cleanup resolves against).
 * @returns The {@link AdoptArgs} to pass to {@link cancelActivity}.
 */
const adoptArgsFromCancel = (turnIds: TurnIds, invocation: Invocation, cancelEventId: string): AdoptArgs => ({
  runId: turnIds.runId,
  invocationId: turnIds.invocationId,
  invocation,
  triggerEventId: cancelEventId,
});

// ---------------------------------------------------------------------------
// Observer: wire capture + Tree hydration
// ---------------------------------------------------------------------------

interface WireObserver {
  /** Every raw Ably message seen on the channel, in arrival order. */
  messages: Ably.InboundMessage[];
  /** Resolve once `predicate` holds for the accumulated messages. */
  until: (predicate: (messages: Ably.InboundMessage[]) => boolean, label: string, timeout?: number) => Promise<void>;
  /** The fully folded projection across every message observed so far. */
  readonly projection: VercelProjection;
}

/**
 * Subscribe a fresh client to the channel and record every raw message, folding
 * each decoded event into a running projection. Used to assert the exact wire
 * sequence AND to read the reconstructed conversation from the live fold.
 * @param channelName - The shared session channel.
 * @returns A {@link WireObserver}.
 */
const observeWire = async (channelName: string): Promise<WireObserver> => {
  const client = ablyRealtimeClient();
  const channel = client.channels.get(channelName);
  const decoder = UIMessageCodec.createDecoder();
  let projection = UIMessageCodec.init();
  const messages: Ably.InboundMessage[] = [];
  const waiters: { predicate: (m: Ably.InboundMessage[]) => boolean; resolve: () => void }[] = [];

  await channel.subscribe((msg) => {
    messages.push(msg);
    const { inputs, outputs } = decoder.decode(msg);
    const codecMessageId = headersOf(msg)[HEADER_CODEC_MESSAGE_ID];
    for (const event of toCodecEvents({ inputs, outputs })) {
      projection = UIMessageCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: codecMessageId });
    }
    // Resolve every satisfied waiter; iterate a snapshot since we splice.
    const satisfied = waiters.filter((w) => w.predicate(messages));
    for (const w of satisfied) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  });

  return {
    messages,
    get projection() {
      return projection;
    },
    until: async (predicate, label, timeout = 15_000): Promise<void> => {
      if (predicate(messages)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === wrapped);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`observer timed out waiting for: ${label}`));
        }, timeout);
        const wrapped = (): void => {
          clearTimeout(timer);
          resolve();
        };
        waiters.push({ predicate, resolve: wrapped });
      });
    },
  };
};

/**
 * Stand up a FRESH client session and hydrate its Tree from channel history -
 * the cross-device reconstruction proof (a brand-new process reads the whole
 * conversation off the channel). Pages history until no older history remains.
 * @param channelName - The shared session channel.
 * @returns The connected client session (the caller closes it).
 */
const hydrateFreshSession = async (channelName: string): Promise<ClientSessionT> => {
  const session = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
    client: ablyRealtimeClient(),
    channelName,
    codec: UIMessageCodec,
  });
  await session.connect();
  // Page to the conversation root so a multi-page history reconstructs fully.
  for (let i = 0; i < 10 && session.view.hasOlder(); i++) {
    await session.view.loadOlder(100);
  }
  return session;
};

const namesOf = (messages: Ably.InboundMessage[]): string[] => messages.map((m) => m.name ?? '');
const countOf = (messages: Ably.InboundMessage[], name: string): number =>
  messages.filter((m) => m.name === name).length;

/**
 * Find the first message matching `predicate`, failing the test (rather than
 * returning `undefined`) when none matches - so call sites read the result
 * without a non-null assertion. Every use is guarded by a prior `observer.until`
 * for the same condition, so a miss is a real test failure.
 * @param messages - The observed messages.
 * @param predicate - The match predicate.
 * @param label - A human-readable description for the failure message.
 * @returns The first matching message.
 */
const mustFind = (
  messages: Ably.InboundMessage[],
  predicate: (msg: Ably.InboundMessage) => boolean,
  label: string,
): Ably.InboundMessage => {
  const found = messages.find((m) => predicate(m));
  if (found === undefined) expect.fail(`expected a message: ${label}`);
  return found;
};

/**
 * Find a message by its event name, failing the test when absent.
 * @param messages - The observed messages.
 * @param name - The wire event name to match.
 * @returns The first message with that name.
 */
const mustFindByName = (messages: Ably.InboundMessage[], name: string): Ably.InboundMessage =>
  mustFind(messages, (m) => m.name === name, name);
const assistantTextOf = (session: ClientSessionT): string =>
  session.view
    .getMessages()
    .map((m) => m.message)
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts.filter((p): p is AI.TextUIPart => p.type === 'text'))
    .map((p) => p.text)
    .join('');

/**
 * Narrow a {@link VercelRunOutcome} to the non-suspend arm {@link endActivity}
 * accepts, failing the test if it is a suspend (the suspend cases route to
 * {@link suspendActivity}, so a `'suspend'` here is a test-setup error). Keeps
 * the driver's `endActivity(..., outcome)` call type-correct without an `as`
 * cast.
 * @param outcome - The step outcome.
 * @returns The same outcome typed as a terminal (non-suspend) outcome.
 */
const asTerminal = (outcome: VercelRunOutcome): Exclude<VercelRunOutcome, { reason: 'suspend' }> => {
  if (outcome.reason === 'suspend') expect.fail('expected a terminal outcome, got suspend');
  return outcome;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('durable cross-process matrix', () => {
  afterEach(() => {
    closeAllClients();
  });

  // -------------------------------------------------------------------------
  // 1. Lifecycle split - open / step / end each a separate process.
  // -------------------------------------------------------------------------
  it('splits a single turn across three processes (open / step / end) producing the canonical single-turn wire, and a fresh observer hydrates the whole conversation', async () => {
    const channelName = uniqueChannelName('dx-split');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-split' });

    const observer = await observeWire(channelName);

    // The client publishes the triggering input (out-of-band, like send()).
    const { invocation, inputEventId } = await publishInput(channelName, publisher, {
      text: 'Split me across processes',
      codecMessageId: 'u-split',
    });

    // Process A: openActivity (a fresh client) publishes ai-run-start, returns ids.
    const ids = await openActivity(invocation, opts);
    expect(ids.runId).toBeTruthy();
    expect(ids.invocationId).toBeTruthy();

    // Process B: stepActivity (a FRESH client) adopts + loads + runs ONE step.
    const stepOutcome = await stepActivity(
      adoptArgs(ids, invocation, inputEventId),
      opts,
      () => fixtureResult('Hello from a separate step process'),
      { stepId: 'wf-step-1' },
    );
    expect(stepOutcome).toEqual({ reason: 'complete' });

    // Process C: endActivity (a FRESH client) adopts + loads + ends.
    await endActivity(adoptArgs(ids, invocation, inputEventId), opts, asTerminal(stepOutcome));

    await observer.until((m) => m.some((x) => x.name === EVENT_RUN_END), 'run-end');

    // The wire is exactly the single-turn sequence: run-start, then the implicit
    // step bracket around output, then run-end - with NO second run-start (the
    // step + end processes adopted; they did not republish the opening event).
    const lifecycle = observer.messages.filter((m) =>
      [EVENT_RUN_START, EVENT_STEP_START, EVENT_STEP_END, EVENT_RUN_END].includes(m.name ?? ''),
    );
    expect(namesOf(lifecycle)).toEqual([EVENT_RUN_START, EVENT_STEP_START, EVENT_STEP_END, EVENT_RUN_END]);
    expect(countOf(observer.messages, EVENT_RUN_START)).toBe(1);
    expect(countOf(observer.messages, EVENT_RUN_RESUME)).toBe(0);

    // The step + the run-end carry the run-id opened by the FIRST process - proof
    // the later processes adopted the same run rather than opening their own.
    const stepStart = mustFindByName(lifecycle, EVENT_STEP_START);
    const runEnd = mustFindByName(lifecycle, EVENT_RUN_END);
    expect(headersOf(stepStart)[HEADER_RUN_ID]).toBe(ids.runId);
    expect(headersOf(runEnd)[HEADER_RUN_ID]).toBe(ids.runId);
    expect(headersOf(runEnd)[HEADER_RUN_REASON]).toBe('complete');

    // A FRESH observer hydrates the complete conversation off the channel: the
    // one user message + the assistant turn.
    const hydrated = await hydrateFreshSession(channelName);
    try {
      const messages = hydrated.view.getMessages().map((m) => m.message);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text).toBe(
        'Split me across processes',
      );
      expect(assistantTextOf(hydrated)).toBe('Hello from a separate step process');
    } finally {
      await hydrated.close();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Crash-recovery supersede - an abandoned partial step is superseded by a
  //    fresh-process retry under the same stepId with attempt+1.
  // -------------------------------------------------------------------------
  it('supersedes an abandoned partial step from a fresh process (same stepId, later serial), gating the dead partial out of a fresh observer', async () => {
    const channelName = uniqueChannelName('dx-supersede');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-sup' });

    // The witness subscribes BEFORE the run opens so it captures ai-run-start.
    const witness = await observeWire(channelName); // witnesses the run + both attempts

    const { invocation, inputEventId } = await publishInput(channelName, publisher, {
      text: 'Recover from a crashed step',
      codecMessageId: 'u-sup',
    });

    const ids = await openActivity(invocation, opts);

    // Process B (attempt 1): stream a PARTIAL step, then ABANDON the process
    // (close its client mid-step) before the step ends. We drive a step whose
    // stream stalls after a partial chunk, abort it via an external signal to
    // release the step, then never end the run from this process.
    const abandonController = new AbortController();
    const deadClient = ablyRealtimeClient();

    const abandonedStep = stepActivity(
      adoptArgs(ids, invocation, inputEventId),
      { channelName, signal: abandonController.signal, client: deadClient },
      () => ({
        // A stream that emits a partial chunk then never finishes - the abort
        // releases the pipe. This is the "worker died mid-step" shape.
        toUIMessageStream: (): ReadableStream<VercelOutput> =>
          new ReadableStream<VercelOutput>({
            start: (controller) => {
              controller.enqueue({ type: 'start', messageId: 'dead-partial' });
              controller.enqueue({ type: 'start-step' });
              controller.enqueue({ type: 'text-start', id: 'dead-txt' });
              controller.enqueue({ type: 'text-delta', id: 'dead-txt', delta: 'DEAD partial answer' });
              // never closes
            },
          }),
        finishReason: Promise.resolve('stop'),
      }),
      { stepId: 'wf-step-X' },
    );

    // Wait for attempt 1's output to land on the channel, then abandon it. The
    // dead partial is identified by its content (both attempts share stepId
    // `wf-step-X`; the canonical attempt is distinguished by its later serial).
    await witness.until(
      (m) =>
        m.some(
          (x) =>
            x.name === EVENT_AI_OUTPUT &&
            headersOf(x)[HEADER_STEP_ID] === 'wf-step-X' &&
            JSON.stringify(x.data).includes('DEAD partial answer'),
        ),
      'attempt-1 output',
    );
    abandonController.abort();
    // The abandoned activity resolves (cancelled) or rejects; either way the dead
    // process is done. Swallow - the workflow would simply reschedule.
    await abandonedStep.catch(() => {
      /* the abandoned attempt's rejection is expected; a workflow reschedules */
    });

    // Process B' (attempt 2): a FRESH client re-executes the SAME stepId. Its
    // re-emitted ai-step-start carries a NEW (later) channel serial, so it is the
    // canonical attempt and supersedes the dead one - no attempt id needed.
    const retryOutcome = await stepActivity(
      adoptArgs(ids, invocation, inputEventId),
      opts,
      () => fixtureResult('FULL recovered answer'),
      { stepId: 'wf-step-X' },
    );
    expect(retryOutcome).toEqual({ reason: 'complete' });

    await endActivity(adoptArgs(ids, invocation, inputEventId), opts, asTerminal(retryOutcome));

    // Two step-starts landed under the same stepId (the dead attempt and the
    // retry); the LATER-serial one is the canonical retry. Both carry the
    // adopt-seeded owner (the run owner the open process seeded), distinct from
    // any per-process connection id.
    const runStart = mustFindByName(witness.messages, EVENT_RUN_START);
    const ownerId = headersOf(runStart)[HEADER_RUN_CLIENT_ID];
    const stepStarts = witness.messages.filter(
      (m) => m.name === EVENT_STEP_START && headersOf(m)[HEADER_STEP_ID] === 'wf-step-X',
    );
    expect(stepStarts.length).toBeGreaterThanOrEqual(2);
    const retryStart = stepStarts.at(-1);
    if (retryStart === undefined) throw new Error('expected a retry step-start under wf-step-X');
    expect(headersOf(retryStart)[HEADER_RUN_CLIENT_ID]).toBe(ownerId);

    // A FRESH observer (hydrating from history AFTER the supersede) shows ONLY the
    // canonical attempt - the dead partial is gated out.
    const hydrated = await hydrateFreshSession(channelName);
    try {
      const text = assistantTextOf(hydrated);
      expect(text).toContain('FULL recovered answer');
      expect(text).not.toContain('DEAD partial answer');
      const assistantCount = hydrated.view
        .getMessages()
        .map((m) => m.message)
        .filter((m) => m.role === 'assistant').length;
      expect(assistantCount).toBe(1);
    } finally {
      await hydrated.close();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Error terminal - a fresh-process step whose stream errors THROWS; the
  //    driver's error arm then endActivity({error}). step-end{failed} precedes
  //    run-end{error}, both from fresh processes.
  // -------------------------------------------------------------------------
  it('a fresh-process step error throws; the driver ends the run in error, with ai-step-end{failed} preceding ai-run-end{error} on the wire', async () => {
    const channelName = uniqueChannelName('dx-error');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-err' });

    const { invocation, inputEventId } = await publishInput(channelName, publisher, {
      text: 'Make the step error',
      codecMessageId: 'u-err',
    });

    const ids = await openActivity(invocation, opts);
    const observer = await observeWire(channelName);

    // The step driver THROWS on a stream error (the throw-to-retry contract).
    await expect(
      stepActivity(adoptArgs(ids, invocation, inputEventId), opts, () => erroringResult(), {
        stepId: 'wf-step-E',
      }),
    ).rejects.toBeTruthy();

    // The workflow's error arm publishes the terminal from a FRESH process.
    await endActivity(adoptArgs(ids, invocation, inputEventId), opts, {
      reason: 'error',
      error: new Ably.ErrorInfo('step failed after retries', 50000, 500),
    });

    await observer.until((m) => m.some((x) => x.name === EVENT_RUN_END), 'run-end');

    // ai-step-end{failed} precedes ai-run-end{error}.
    const stepEndIdx = observer.messages.findIndex((m) => m.name === EVENT_STEP_END);
    const runEndIdx = observer.messages.findIndex((m) => m.name === EVENT_RUN_END);
    expect(stepEndIdx).not.toBe(-1);
    expect(stepEndIdx).toBeLessThan(runEndIdx);
    expect(headersOf(mustFindByName(observer.messages, EVENT_STEP_END))[HEADER_STEP_REASON]).toBe('failed');
    expect(headersOf(mustFindByName(observer.messages, EVENT_RUN_END))[HEADER_RUN_REASON]).toBe('error');
    expect(countOf(observer.messages, EVENT_RUN_END)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Cancel. An in-flight step (adopt + load + createStep) is cancelled: it
  //    closes ai-step-end{cancelled} and, because pipe never auto-ends and the
  //    activity hands off via session.close(), publishes NO run-end. A separate
  //    cancel cleanup (fresh client, I_cancel) publishes the SOLE terminal.
  //    Exactly one run-end{cancelled} across BOTH arms. This is the close()-vs-
  //    end() usage pattern, with no run flag.
  // -------------------------------------------------------------------------
  it('an in-flight step cancelled mid-step publishes no run-end; a separate cancel cleanup publishes the sole ai-run-end{cancelled} (exactly one across both arms)', async () => {
    const channelName = uniqueChannelName('dx-cancel-durable');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-cd' });
    const cancelClient = ablyRealtimeClient();
    const observer = await observeWire(channelName);

    const { invocation, inputEventId } = await publishInput(channelName, publisher, {
      text: 'Cancel me mid-step',
      codecMessageId: 'u-cd',
    });

    const ids = await openActivity(invocation, opts);

    // The in-flight step: a stalling stream, cancelled from inside produce (which
    // runs after load(), when the session is subscribed and its cancel listener
    // is live). The activity hands off via session.close() in its finally.
    const inFlight = stepActivity(
      adoptArgs(ids, invocation, inputEventId),
      opts,
      () => ({
        toUIMessageStream: (): ReadableStream<VercelOutput> =>
          new ReadableStream<VercelOutput>({
            start: (controller) => {
              controller.enqueue({ type: 'start', messageId: 'cd-msg' });
              controller.enqueue({ type: 'start-step' });
              controller.enqueue({ type: 'text-start', id: 'cd-txt' });
              controller.enqueue({ type: 'text-delta', id: 'cd-txt', delta: 'Partial...' });
              // never closes - released by the cancel abort
              void cancelClient.channels.get(channelName).publish({
                name: EVENT_CANCEL,
                extras: { ai: { transport: { [HEADER_RUN_ID]: ids.runId } } },
              });
            },
          }),
        finishReason: Promise.resolve('stop'),
      }),
      { stepId: 'wf-step-CD' },
    );

    const inFlightOutcome = await inFlight;
    expect(inFlightOutcome).toEqual({ reason: 'cancelled' });

    // The step-end{cancelled} bracket fired, but the in-flight arm handed off via
    // session.close() and published NO run terminal.
    await observer.until((m) => m.some((x) => x.name === EVENT_STEP_END), 'step-end');
    expect(headersOf(mustFindByName(observer.messages, EVENT_STEP_END))[HEADER_STEP_REASON]).toBe('cancelled');
    expect(countOf(observer.messages, EVENT_RUN_END)).toBe(0);

    // The workflow's cleanup arm: cancelActivity (a fresh client) stamped
    // I_cancel, publishes the SOLE terminal.
    const cancelEventId = crypto.randomUUID();
    await cancelClient.channels.get(channelName).publish({
      name: EVENT_CANCEL,
      extras: { ai: { transport: { [HEADER_RUN_ID]: ids.runId, 'event-id': cancelEventId } } },
    });
    await cancelActivity(
      adoptArgsFromCancel({ runId: ids.runId, invocationId: 'I_cancel' }, invocation, cancelEventId),
      opts,
    );

    await observer.until((m) => m.some((x) => x.name === EVENT_RUN_END), 'cleanup run-end');

    // Exactly ONE ai-run-end{cancelled} across BOTH arms - no double, no zero.
    expect(countOf(observer.messages, EVENT_RUN_END)).toBe(1);
    const runEnd = mustFindByName(observer.messages, EVENT_RUN_END);
    expect(headersOf(runEnd)[HEADER_RUN_REASON]).toBe('cancelled');
    // The terminal is stamped with the cleanup's I_cancel invocation, not the
    // step's invocation - the sole publisher is the workflow cleanup arm.
    expect(headersOf(runEnd)['invocation-id']).toBe('I_cancel');
  });

  // -------------------------------------------------------------------------
  // 5. Suspend / resume - step then suspend; a fresh continuation openActivity
  //    (trigger carries the run-id) publishes ai-run-resume (new invocationId) +
  //    a new step. The resume is NOT a second run-start.
  // -------------------------------------------------------------------------
  it('suspends then resumes from a fresh continuation process: ai-run-resume (new invocationId) + a new step, not a second ai-run-start', async () => {
    const channelName = uniqueChannelName('dx-resume');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-resume' });
    const observer = await observeWire(channelName);

    // Turn 1: open + a step that suspends (finishReason 'tool-calls') + suspend.
    const first = await publishInput(channelName, publisher, {
      text: 'Start, then suspend',
      codecMessageId: 'u-resume-1',
    });
    const ids = await openActivity(first.invocation, opts);

    const suspendOutcome = await stepActivity(
      adoptArgs(ids, first.invocation, first.inputEventId),
      opts,
      () => fixtureResult('Awaiting a tool result', 'tool-calls'),
      { stepId: 'wf-resume-step-1' },
    );
    expect(suspendOutcome).toEqual({ reason: 'suspend' });
    await suspendActivity(adoptArgs(ids, first.invocation, first.inputEventId), opts);
    await observer.until((m) => m.some((x) => x.name === EVENT_RUN_SUSPEND), 'run-suspend');

    // Turn 2 (the continuation): a NEW input carrying the SAME run-id on the wire
    // (the continuation trigger). openActivity on it publishes ai-run-resume - NOT
    // a second ai-run-start - and mints a fresh invocationId.
    const cont = await publishInput(channelName, publisher, {
      text: 'Here is the tool result',
      codecMessageId: 'u-resume-2',
      runId: ids.runId,
    });
    const resumeIds = await openActivity(cont.invocation, opts);
    expect(resumeIds.runId).toBe(ids.runId);
    expect(resumeIds.invocationId).not.toBe(ids.invocationId);

    // A new step under the resumed run, then end.
    const resumeStep = await stepActivity(
      adoptArgs(resumeIds, cont.invocation, cont.inputEventId),
      opts,
      () => fixtureResult('Resumed and finished'),
      { stepId: 'wf-resume-step-2' },
    );
    await endActivity(adoptArgs(resumeIds, cont.invocation, cont.inputEventId), opts, asTerminal(resumeStep));
    await observer.until((m) => m.some((x) => x.name === EVENT_RUN_END), 'run-end');

    // Exactly one run-start, exactly one run-resume - the continuation re-entered
    // the run, it did not open a second one.
    expect(countOf(observer.messages, EVENT_RUN_START)).toBe(1);
    expect(countOf(observer.messages, EVENT_RUN_RESUME)).toBe(1);
    const resume = mustFindByName(observer.messages, EVENT_RUN_RESUME);
    expect(headersOf(resume)[HEADER_RUN_ID]).toBe(ids.runId);
    expect(headersOf(resume)['invocation-id']).toBe(resumeIds.invocationId);
  });

  // -------------------------------------------------------------------------
  // 6. stepClientId cross-process stickiness - process B's step sets a
  //    stepClientId; process B' (fresh, no in-memory cursor) runs the NEXT step
  //    with NO explicit stepClientId and re-derives the SAME sticky value FROM
  //    THE CHANNEL. The cross-process proof B's in-memory-cursor death rests on.
  // -------------------------------------------------------------------------
  it("a fresh-process step re-derives the prior step's sticky stepClientId from the channel (no in-memory cursor)", async () => {
    const channelName = uniqueChannelName('dx-sticky');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-sticky' });
    const observer = await observeWire(channelName);

    const { invocation, inputEventId } = await publishInput(channelName, publisher, {
      text: 'Sticky step client',
      codecMessageId: 'u-sticky',
    });
    const ids = await openActivity(invocation, opts);

    // Step 1 (process B): set an EXPLICIT stepClientId (the seam a steer would
    // populate). The step driver does not expose stepClientId, so step 1 sets it
    // via a raw adopt + createStep in its own fresh-client session.
    const sessionB = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: ablyRealtimeClient(),
      channelName,
      codec: UIMessageCodec,
    });
    await sessionB.connect();
    const runB = sessionB.adoptRun({
      runId: ids.runId,
      invocationId: ids.invocationId,
      triggerEventId: inputEventId,
    });
    await runB.load();
    const stepB = runB.createStep({
      stepId: 'wf-sticky-1',
      stepClientId: 'steerer-X',
    });
    await stepB.start();
    await stepB.pipe(fixtureResult('first step').toUIMessageStream());
    await stepB.end();
    await sessionB.close();

    await observer.until(
      (m) => m.some((x) => x.name === EVENT_STEP_END && headersOf(x)[HEADER_STEP_ID] === 'wf-sticky-1'),
      'step-1 end',
    );

    // Step 2 (process B', a FRESH client via the step driver): NO explicit
    // stepClientId, NO new input. Its in-memory cursor is empty (fresh process),
    // so it re-derives the SAME sticky stepClientId from the channel (the prior
    // step's step-client-id), NOT the empty default and NOT the run owner.
    const step2 = await stepActivity(
      adoptArgs(ids, invocation, inputEventId),
      opts,
      () => fixtureResult('second step'),
      { stepId: 'wf-sticky-2' },
    );
    await endActivity(adoptArgs(ids, invocation, inputEventId), opts, asTerminal(step2));
    await observer.until(
      (m) => m.some((x) => x.name === EVENT_STEP_END && headersOf(x)[HEADER_STEP_ID] === 'wf-sticky-2'),
      'step-2 end',
    );

    const step2Start = mustFind(
      observer.messages,
      (m) => m.name === EVENT_STEP_START && headersOf(m)[HEADER_STEP_ID] === 'wf-sticky-2',
      'step-2 start',
    );
    const step2End = mustFind(
      observer.messages,
      (m) => m.name === EVENT_STEP_END && headersOf(m)[HEADER_STEP_ID] === 'wf-sticky-2',
      'step-2 end',
    );
    // The sticky stepClientId carried across the process boundary, re-derived
    // from the channel - distinct from the run owner.
    expect(headersOf(step2Start)[HEADER_STEP_CLIENT_ID]).toBe('steerer-X');
    expect(headersOf(step2End)[HEADER_STEP_CLIENT_ID]).toBe('steerer-X');
    const runStart = mustFindByName(observer.messages, EVENT_RUN_START);
    expect(headersOf(step2Start)[HEADER_STEP_CLIENT_ID]).not.toBe(headersOf(runStart)[HEADER_RUN_CLIENT_ID]);
  });

  // -------------------------------------------------------------------------
  // 7. Reconnect / hydration - a fresh observer attaches AFTER a supersede and
  //     hydrates from history across pages; canonical-only (no dead partial).
  //     Distinct from #2 (which hydrates one turn): here multiple prior turns
  //     plus the superseded turn exercise the multi-page history walk.
  // -------------------------------------------------------------------------
  it('a fresh observer attaching after a supersede hydrates canonical-only across multiple history pages', async () => {
    const channelName = uniqueChannelName('dx-reconnect');
    const opts: ActivityOptions = { channelName };
    const publisher = ablyRealtimeClient({ clientId: 'user-rc' });

    // Two clean prior turns so the supersede turn is not the only history (the
    // fresh observer must walk back through several runs).
    for (const n of [1, 2]) {
      const turn = await publishInput(channelName, publisher, {
        text: `prior turn ${String(n)} question`,
        codecMessageId: `u-rc-${String(n)}`,
      });
      const turnIds = await openActivity(turn.invocation, opts);
      const out = await stepActivity(
        adoptArgs(turnIds, turn.invocation, turn.inputEventId),
        opts,
        () => fixtureResult(`prior turn ${String(n)} answer`),
        { stepId: `wf-rc-${String(n)}` },
      );
      await endActivity(adoptArgs(turnIds, turn.invocation, turn.inputEventId), opts, asTerminal(out));
    }

    // A third turn with a step retry: a failed first attempt, then a superseding
    // retry under the same stepId, then end. (A failed first attempt cleanly
    // settles, so the retry's later-serial start is canonical.)
    const last = await publishInput(channelName, publisher, {
      text: 'final turn question',
      codecMessageId: 'u-rc-3',
    });
    const lastIds = await openActivity(last.invocation, opts);
    await expect(
      stepActivity(adoptArgs(lastIds, last.invocation, last.inputEventId), opts, () => erroringResult(), {
        stepId: 'wf-rc-3',
      }),
    ).rejects.toBeTruthy();
    const recovered = await stepActivity(
      adoptArgs(lastIds, last.invocation, last.inputEventId),
      opts,
      () => fixtureResult('FINAL canonical answer'),
      { stepId: 'wf-rc-3' },
    );
    await endActivity(adoptArgs(lastIds, last.invocation, last.inputEventId), opts, asTerminal(recovered));

    // A FRESH observer attaches now (AFTER the supersede) and hydrates from
    // history. It walks every turn and shows ONLY canonical output - the failed
    // attempt's partial is gated out.
    const hydrated = await hydrateFreshSession(channelName);
    try {
      const messages = hydrated.view.getMessages().map((m) => m.message);
      // Three turns: user/assistant x3.
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      const text = assistantTextOf(hydrated);
      expect(text).toContain('prior turn 1 answer');
      expect(text).toContain('prior turn 2 answer');
      expect(text).toContain('FINAL canonical answer');
      // The dead attempt's partial never materialises.
      expect(text).not.toContain('partial...');
    } finally {
      await hydrated.close();
    }
  });
});
