/**
 * Chat API route — the agent behind the useChat adapter's POST.
 *
 * The adapter publishes every input on the Ably channel first, then POSTs a
 * pointer `{channelName, eventId, runId?}` here to wake the agent. The route
 * builds a fresh agent transport on the named channel, locates the triggering
 * input in channel history, folds the channel's history into the conversation,
 * opens the run, and returns `{runId}` immediately — the streaming happens
 * after the response, inside `after()`, and reaches the client over Ably
 * rather than this HTTP response.
 *
 * Three tool execution patterns flow through here:
 * - Server-executed tools (getWeather, updateChecklist): streamText runs them
 *   inline, looping steps within the single run.
 * - Client-executed tools (getLocation): streamText finishes with
 *   `finishReason: 'tool-calls'`, the run suspends, the client executes the
 *   tool and publishes the output chunk, and its continuation POST resumes
 *   the run here (the published output carries the run-id header).
 * - Approval-gated tools (getWeatherForecast): the run suspends at
 *   `approval-requested`; the client publishes the approval decision and POSTs
 *   a continuation. The folded conversation then carries the
 *   `approval-responded` part, so the tool's `needsApproval` returns false and
 *   streamText executes it without re-pausing.
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs, toUIMessageStream } from 'ai';
import Ably from 'ably';
import { LiveObjects } from 'ably/liveobjects';
import { createAgentTransport, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { channelAgent, ErrorCode, OBJECT_MODES, resolveChannelModes } from '@ably/ai-transport';
import { createModel } from './model';
import { tools } from './tools';
import { makeChecklistTool } from './checklist-tool';
import { checklistFrom, type ChecklistItemRow, type ChecklistRoot } from '../../lib/checklist';
import { getExistingMessages } from '../../lib/get-existing-messages';

/**
 * The pointer body the useChat adapter POSTs. The adapter also sends `runId`
 * on a continuation; the route does not read it — the trigger's own run-id
 * header names the run to resume.
 */
interface ChatRequestBody {
  channelName: string;
  eventId: string;
}

const systemPrompt = (steps: ChecklistItemRow[]): string =>
  `You are a helpful assistant. When the user asks about weather, use the getWeather tool. If they don't specify a location, call getLocation first to get their coordinates, then call getWeather with a description of that location. When the user asks about a weather forecast or upcoming weather, use getWeatherForecast.

When a request takes several steps, keep a live checklist beside the chat with the updateChecklist tool so the user can watch your progress: first call it with \`plan\` to lay out the steps, then as you work call it with \`start\` when you begin a step and \`complete\` when you finish one — one step at a time. Skip the checklist for simple one-step answers.

Current checklist (live, authoritative):
${JSON.stringify(steps, null, 2)}`;

export async function POST(req: Request) {
  const body = (await req.json()) as ChatRequestBody;

  // A fresh Ably client per request (trusted environment, API key direct).
  // The agent is ephemeral: it attaches the channel, locates the triggering
  // input in history, streams the response, and closes. A per-request client
  // keeps concurrent runs on the same channel from detaching each other.
  // `ABLY_ENDPOINT` lets the e2e tests point the agent at the Ably sandbox
  // (`nonprod:sandbox`); unset in normal use, so it defaults to production.
  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    // The checklist state lives in LiveObjects, an ably-js plugin — without it
    // `channel.object` throws.
    plugins: { LiveObjects },
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });

  // The route owns its channel: the transport does not resolve channels or
  // modes. OBJECT_MODES requests the object channel modes alongside the modes
  // the transport always needs, so the checklist tool can write LiveObjects
  // through `channel.object`.
  const channel = ably.channels.get(body.channelName, {
    params: { agent: channelAgent() },
    modes: resolveChannelModes(OBJECT_MODES),
  });
  const transport = createAgentTransport({ channel });

  const close = (): void => {
    transport.close();
    ably.close();
  };

  let run;
  let conversation;
  try {
    // Connect AFTER the trigger was published (this route runs per POST):
    // locateInput and history are bounded at the channel attach point, so the
    // triggering input is inside the window they scan.
    await transport.connect();

    const located = await transport.locateInput(body.eventId);
    if (!located) {
      close();
      return Response.json({ error: 'input event not found' }, { status: 404 });
    }

    // The conversation for the model, via the demo's swappable history source
    // (see get-existing-messages.ts).
    conversation = await getExistingMessages(transport);

    // The located input drives the open: a continuation input carries the
    // run-id header of the run it resumes, and a fresh send carries none —
    // the transport re-enters or starts accordingly, anchors the run to the
    // trigger so cancels route, and threads its structure so clients can
    // anchor the reply.
    run = transport.openRun({ input: located }, { signal: req.signal });
  } catch (error) {
    close();
    throw error;
  }

  const openedRun = run;
  const messages = conversation;

  after(async () => {
    try {
      // Object state has synced by the time get() resolves, so the snapshot
      // reflects the checklist as it stands before this run — the model
      // resumes from the current progress without conversation archaeology.
      const root = await channel.object.get<ChecklistRoot>();
      const steps = checklistFrom(root.compactJson());

      const result = streamText({
        model: createModel(),
        system: systemPrompt(steps),
        messages: await convertToModelMessages(messages),
        tools: { ...tools, ...makeChecklistTool(root, () => Date.now()) },
        abortSignal: openedRun.abortSignal,
        // Multi-step: streamText loops inference + server-tool execution within
        // this call, so each updateChecklist call chains straight into the next
        // inference pass. Client-executed tools (getLocation) and
        // approval-requested tools finish the call with
        // `finishReason: 'tool-calls'`, which suspends the run below.
        stopWhen: stepCountIs(10),
      });

      const pipeResult = await openedRun.pipe(toUIMessageStream({ stream: result.fullStream }));
      const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
      if (outcome.reason === 'suspend') {
        await openedRun.suspend();
      } else {
        // We choose to forward the run's terminal error so clients can show why
        // the run failed; a server could omit it to avoid exposing internal
        // failure detail.
        await openedRun.end(outcome);
      }
    } catch (error) {
      // The run has already opened on the channel; end it so clients don't see
      // a permanently active run.
      const message = error instanceof Error ? error.message : String(error);
      await openedRun.end({
        reason: 'error',
        error: new Ably.ErrorInfo(`unable to complete run; ${message}`, ErrorCode.RunResponseStreamFailed, 500),
      });
    } finally {
      close();
    }
  });

  // The adapter needs the run-id before the stream flows: it filters the
  // channel's events into useChat's chunk stream by this id.
  return Response.json({ runId: openedRun.runId });
}
