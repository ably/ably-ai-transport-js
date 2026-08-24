/**
 * useToolResolution — publishes a tool resolution and wakes the agent only once
 * every tool call on the run has an answer.
 *
 * One model turn can emit several calls that each need the client: two
 * approval-gated calls ("the forecast for Paris and London"), or a gated call
 * alongside a client-executed one. The agent's model input must carry a matching
 * output for every open `function_call`, so waking the run after the first answer
 * makes the provider reject the resumed request. The resolution itself always
 * publishes immediately — only the wake POST waits for the last answer.
 *
 * A client's own resolution reaches the merge only as the ordinary channel
 * delivery (the transport emits nothing locally on publish), so the merged
 * thread does not reflect the answer until that lands. Reading the thread alone would
 * therefore never see the run become ready. The hook closes that gap by
 * remembering the `call_id`s it has answered and treating them as answered on
 * top of what the thread shows, which keeps the decision in the resolving call
 * itself — no effect watching the thread, and the wake carries the ids of the
 * publish that just happened.
 *
 * A call counts as answered by {@link unansweredCalls}: it has a
 * `function_call_output`, or its approval is `approved` (the agent runs those
 * server-side on resume). A denial's resolution publishes a rejection
 * `function_call_output` alongside the decision, so the resolved check covers it.
 */

import { useCallback, useRef } from 'react';
import type { ClientTransport } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import { unansweredCalls, type OpenAIInput } from '../lib/openai-thread';

import type { ThreadMessage } from '../lib/merge-thread';

/** One tool call's resolution: the inputs to publish and the call they answer. */
export interface ToolResolution {
  /** The codec-message-id of the assistant message holding the `function_call` being answered. */
  codecMessageId: string;
  /** The run the call belongs to — the continuation the wake resumes. */
  runId: string;
  /** The `call_id` this resolution answers. */
  callId: string;
  /**
   * The inputs to publish, in order — a tool result item, or an approval
   * decision (a denial pairs the decision with a rejection
   * `function_call_output` so the model round-trip has no dangling call).
   */
  inputs: OpenAIInput[];
}

/** What the hook passes to `onWake` once a resolution answers the run's last call. */
export interface ToolResolutionWake {
  /** The `event-id` of the last published resolution input, for the agent's `locateInput`. The published input carries the run-id header, so the wake needs no run identity of its own. */
  eventId: string;
}

/** Options for {@link useToolResolution}. */
export interface UseToolResolutionOptions {
  /** The client transport to publish the resolution on. */
  transport: ClientTransport<OpenAIInput, OpenAIOutput> | undefined;
  /** The merged thread, read to find the run's still-unanswered calls. */
  messages: ThreadMessage[];
  /** Wakes the agent for a run, POSTing the resolution's pointer to the agent endpoint. */
  onWake: (wake: ToolResolutionWake) => void;
}

/**
 * Publish a tool resolution, waking the agent only when it answers the run's
 * last outstanding call.
 * @param options - See {@link UseToolResolutionOptions}.
 * @returns A `resolve` function the approval handlers and the client-tool hook
 *   both call; it publishes the resolution and decides whether to wake.
 */
export function useToolResolution(options: UseToolResolutionOptions) {
  const { transport, messages, onWake } = options;
  // The call_ids this tab has answered. Needed because a resolution is
  // wire-only, so the thread lags the answer by a channel round-trip.
  const answeredRef = useRef(new Set<string>());

  return useCallback(
    async ({ codecMessageId, runId, callId, inputs }: ToolResolution): Promise<void> => {
      if (!transport) return;

      // Record the answer and decide whether it was the last one in a single
      // synchronous step, before yielding to the publish. Two approvals clicked
      // in quick succession would otherwise both observe a fully-answered run
      // after their awaits and each wake the agent.
      answeredRef.current.add(callId);
      const runMessages = messages.filter((message) => message.runId === runId);
      const answeredTheLastCall = unansweredCalls(runMessages).every((call) => answeredRef.current.has(call.call_id));

      let eventId: string | undefined;
      for (const input of inputs) {
        // Address the resolution at the message holding the call, under the
        // suspended run's id, so the merge amends that message and the agent's
        // continuation resumes the right run.
        const result = await transport.publishInput(input, { codecMessageId, runId });
        eventId = result.eventId;
      }

      // Publish first, wake second: the agent reads the conversation off the
      // channel, so the resolution has to be there before the POST lands.
      if (answeredTheLastCall && eventId !== undefined) onWake({ eventId });
    },
    [transport, messages, onWake],
  );
}
