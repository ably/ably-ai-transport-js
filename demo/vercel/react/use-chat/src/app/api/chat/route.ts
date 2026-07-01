/**
 * Chat API route — receives messages from the client session's HTTP POST,
 * streams the AI response back over Ably.
 *
 * Supports three tool execution patterns:
 * - Server-executed tools (getWeather): streamText runs them inline.
 * - Client-executed tools (getLocation): the client suspends the run after
 *   the tool call, executes the tool, then sends a continuation invocation
 *   under the same runId. The SDK overlays the client-published tool output
 *   onto the suspended assistant before the conversation is read.
 * - Server-executed gated on approval (getWeatherForecast): suspends at
 *   `approval-requested`. The user approves → the client publishes a
 *   `tool-approval-response` TEvent on the channel → continuation POST →
 *   the conversation reflects the approval. The tool's `needsApproval`
 *   returns `false` once the matching `toolCallId` has an
 *   `approval-responded` part in the messages, so `streamText` executes
 *   it without re-pausing. The codec reducer folds the resulting tool
 *   output onto the original assistant message by matching its
 *   `toolCallId`.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import Ably from 'ably';
import { LiveObjects } from 'ably/liveobjects';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
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

  // A fresh Ably client per request (trusted environment, API key direct).
  // The agent is ephemeral: it attaches the channel, looks up the triggering
  // input event via `untilAttach: true` history, streams the response, and
  // closes. A per-request client keeps concurrent runs on the same channel
  // from detaching each other.
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
  const conversation = run.view.getMessages().map((m) => m.message);

  let result;
  try {
    // Object state has synced by the time get() resolves, so the snapshot
    // reflects the checklist as it stands before this run — the model resumes
    // from the current progress without conversation archaeology. get() rejects
    // when LiveObjects is unavailable; that happens after run-start has
    // published, hence the catch below ends the run.
    const root = await session.object.get<ChecklistRoot>();
    const steps = checklistFrom(root.compactJson());

    result = streamText({
      model: createModel(),
      system: systemPrompt(steps),
      messages: await convertToModelMessages(conversation),
      tools: { ...tools, ...makeChecklistTool(root, () => Date.now()) },
      abortSignal: run.abortSignal,
      // Multi-step: streamText loops inference + server-tool execution within
      // this call, so each updateChecklist call (a server tool) chains straight
      // into the next inference pass. The agent plans, then flips step statuses
      // one at a time across the loop, and the client watches the LiveObjects
      // checklist advance live within the single run. Client-executed tools
      // (getLocation) and approval-requested tools still pause this call
      // naturally — streamText finishes that step with
      // `finishReason: 'tool-calls'`, the run suspends, and the client
      // publishes a continuation.
      stopWhen: stepCountIs(10),
    });
  } catch (error) {
    // The run has already started on the channel; end it so clients don't see
    // a permanently active run, then release the connection.
    await run.end({ reason: 'error' });
    await session.close();
    ably.close();
    throw error;
  }

  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    if (outcome.reason === 'suspend') {
      await run.suspend();
    } else {
      // We choose to forward the run's terminal error so clients can show why
      // the run failed; a server could omit it to avoid exposing internal
      // failure detail.
      await run.end(outcome);
    }
    await session.close();
    ably.close();
  });

  // Return the agent-minted ids on the HTTP response. The agent now mints both
  // the run-id (when the invocation omits it for a fresh run) and the
  // invocation-id; the useChat ChatTransport's POST ignores the body (it routes
  // by run-id over the channel), but the contract is honoured here.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
