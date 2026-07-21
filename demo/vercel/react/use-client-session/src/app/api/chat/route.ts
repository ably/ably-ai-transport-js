/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Continuation handling is entirely inside the SDK: draining `run.view` with
 * `loadOlder()` yields the LLM-ready conversation history, with any
 * client-published tool resolutions (output / approval) already overlaid onto
 * the assistant messages they belong to. No `loadProjection` / overlay code here.
 *
 * - Server-executed tools (getWeather): streamText handles execution inline.
 * - Client-executed tools (getLocation): client suspends after the tool call,
 *   publishes a `tool-output-available` chunk on the channel, then sends
 *   a continuation POST. The SDK overlays the tool result onto the suspended
 *   assistant before the conversation is read.
 * - Approval-required tools (getWeatherForecast): client publishes a
 *   `tool-approval-response` TEvent on Approve. The SDK overlays the
 *   `approval-responded` state. The tool's `needsApproval` returns false
 *   on the second pass, so streamText executes without re-pausing. The
 *   codec reducer folds the resulting tool output onto the original
 *   assistant by matching its `toolCallId`.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai';
import Ably from 'ably';
import { LiveObjects } from 'ably/liveobjects';
import { approvedPendingToolCalls, createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation, OBJECT_MODES } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';
import { makeChecklistTool } from './checklist-tool';
import { checklistFrom, type ChecklistItemRow, type ChecklistRoot } from '../../lib/checklist';

const systemPrompt = (steps: ChecklistItemRow[]): string =>
  `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.

When a request takes several steps, keep a live checklist beside the chat with the updateChecklist tool so the user can watch your progress: first call it with \`plan\` to lay out the steps, then as you work call it with \`start\` when you begin a step and \`complete\` when you finish one — one step at a time. Skip the checklist for simple one-step answers.

Current checklist (live, authoritative):
${JSON.stringify(steps, null, 2)}`;

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  // A fresh Ably client per request. The agent is ephemeral: it attaches the
  // channel, looks up the triggering input event via `untilAttach: true`
  // history, streams the response, and ends its session. A per-request client keeps
  // concurrent runs on the same channel from detaching each other.
  // `ABLY_ENDPOINT` lets the e2e tests point the agent at the Ably sandbox
  // (`nonprod:sandbox`); unset in normal use, so it defaults to production.
  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    // The checklist state lives in LiveObjects, an ably-js plugin — without it
    // `session.object` throws.
    plugins: { LiveObjects },
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  // OBJECT_MODES requests the object channel modes alongside the modes AIT
  // always needs, so reads/writes to `session.object` are permitted.
  const session = createAgentSession({
    client: ably,
    channelName: invocation.sessionName,
    channelModes: OBJECT_MODES,
  });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  // Drain run.view — the one history driver — for the full multi-turn
  // conversation to feed the model, then start. run.messages is only this
  // run's own turn (the unit to persist).
  while (run.view.hasOlder()) await run.view.loadOlder();
  await run.start();

  let root;
  try {
    // Object state has synced by the time get() resolves, so the snapshot
    // reflects the checklist as it stands before this run — the model resumes
    // from the current progress without conversation archaeology. get() rejects
    // when LiveObjects is unavailable; that happens after run-start has
    // published, hence the catch below ends the run.
    root = await session.object.get<ChecklistRoot>();
  } catch (error) {
    // The run has already started on the channel; end it so clients don't see
    // a permanently active run, then release the connection.
    await run.end({ reason: 'error' });
    await session.end();
    ably.close();
    throw error;
  }
  const checklistRoot = root;

  after(async () => {
    // One inference pass over the given conversation. streamText runs its
    // multi-step loop inline, so server-executed tools produce the final
    // response in this call; a client or approval-gated tool ends the step with
    // `finishReason: 'tool-calls'` and the outcome reports a suspend.
    const runInferencePass = async (turn: readonly UIMessage[]) => {
      const steps = checklistFrom(checklistRoot.compactJson());
      const result = streamText({
        model: createModel(),
        system: systemPrompt(steps),
        messages: await convertToModelMessages([...turn]),
        tools: { ...tools, ...makeChecklistTool(checklistRoot, () => Date.now()) },
        abortSignal: run.abortSignal,
        stopWhen: stepCountIs(10),
      });
      const pipeResult = await run.pipe(result.toUIMessageStream());
      return vercelRunOutcome(pipeResult, result.finishReason);
    };

    let outcome: Awaited<ReturnType<typeof vercelRunOutcome>> | undefined;

    // If approved tool calls are trailed by a user message, we resolve them
    // before considering that message. The model rejects a user message that
    // follows an open tool_use with no tool_result between them, so this trims
    // to the last assistant and runs a pass to emit the tool_result first. It
    // runs before the steering loop so it doesn't call `hasInput()`, which keeps
    // the steering message pending for the loop to answer once the tool result
    // is on the channel.
    const resumeTurn = run.view.getMessages().map((m) => m.message);
    const lastAssistant = resumeTurn.map((m) => m.role).lastIndexOf('assistant');
    const steerTrailsToolCall =
      lastAssistant !== -1 && lastAssistant < resumeTurn.length - 1 && approvedPendingToolCalls(resumeTurn).length > 0;
    if (steerTrailsToolCall) {
      outcome = await runInferencePass(resumeTurn.slice(0, lastAssistant + 1));
    }

    // Steering loop. `run.hasInput()` is a delta predicate:
    //   - returns true on the first call (the trigger input is pending),
    //   - returns true again whenever a steering message has folded into the
    //     run since the previous call (the user typed `/steer ...` while we
    //     were streaming),
    //   - returns false only when nothing new has arrived since the previous
    //     call AND the trigger has been processed at least once.
    // Each iteration re-reads `run.view.getMessages()`, so any steering message
    // that folded into the run is included in the model's context for the next
    // inference pass. A suspend / cancel / error outcome breaks the loop.
    while ((outcome === undefined || outcome.reason === 'complete') && run.hasInput()) {
      outcome = await runInferencePass(run.view.getMessages().map((m) => m.message));
      // Exit on any non-complete outcome (suspend / cancel / error). On a
      // `complete` outcome we re-check `hasInput()` at the top: a steering
      // message that arrived during this iteration makes it true again and
      // drives another inference pass that includes it in the conversation.
      if (outcome.reason !== 'complete') break;
    }

    const finalOutcome = outcome ?? { reason: 'complete' as const };
    if (finalOutcome.reason === 'suspend') {
      await run.suspend();
    } else {
      // We choose to forward the run's terminal error so clients can show why
      // the run failed; a server could omit it to avoid exposing internal
      // failure detail.
      await run.end(finalOutcome);
    }
    await session.end();
    ably.close();
  });

  // Return the agent-minted ids on the HTTP response. The agent now mints both
  // the run-id (when the invocation omits it for a fresh run) and the
  // invocation-id; the client reads them back from here.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
