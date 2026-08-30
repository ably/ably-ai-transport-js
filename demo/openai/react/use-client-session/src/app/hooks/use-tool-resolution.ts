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
 * A client's own resolution is wire-only: the transport skips the optimistic fold
 * for an input targeting an existing message, so `view.messages` does not reflect
 * the answer until the channel echo lands. Reading the view alone would therefore
 * never see the run become ready. The hook closes that gap by remembering the
 * `call_id`s it has answered and treating them as answered on top of what the view
 * shows, which keeps the decision in the resolving call itself — no effect
 * watching the view, and the wake carries the `ClientRun` of the send that just
 * happened.
 *
 * A call counts as answered by {@link unansweredCalls}: it has a
 * `function_call_output`, or its approval is `approved` (the agent runs those
 * server-side on resume). A denial resolves itself with a rejection output.
 */

import { useCallback, useRef } from 'react';
import type { ClientRun } from '@ably/ai-transport';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { OpenAIMessage, OpenAISessionInput } from '@ably/ai-transport/openai';
import { unansweredCalls } from '@ably/ai-transport/openai';

/** One tool call's resolution: the input to publish and the call it answers. */
export interface ToolResolution {
  /** The codec-message-id of the message holding the `function_call` being answered. */
  codecMessageId: string;
  /** The `call_id` this resolution answers. */
  callId: string;
  /** The input to publish — a tool result, a tool error, or an approval decision. */
  input: OpenAISessionInput;
}

/** Options for {@link useToolResolution}. */
export interface UseToolResolutionOptions {
  /** The client view to publish the resolution on and to read run state from. */
  view: ViewHandle<OpenAISessionInput, OpenAIMessage>;
  /** Wakes the agent for a run, POSTing its invocation pointer to the agent endpoint. */
  onWake: (run: ClientRun<OpenAISessionInput, OpenAIMessage>) => void;
}

/**
 * Publish a tool resolution, waking the agent only when it answers the run's last
 * outstanding call.
 * @param options - See {@link UseToolResolutionOptions}.
 * @returns A `resolve` function the approval handlers and the client-tool hook
 *   both call; it publishes the resolution and decides whether to wake.
 */
export function useToolResolution(options: UseToolResolutionOptions) {
  const { view, onWake } = options;
  // The call_ids answered in this session. Needed because a resolution is
  // wire-only, so the view lags the answer by a channel round-trip.
  const answeredRef = useRef(new Set<string>());

  return useCallback(
    async ({ codecMessageId, callId, input }: ToolResolution): Promise<void> => {
      const target = view.runOf(codecMessageId);
      if (!target) return;

      // Record the answer and decide whether it was the last one in a single
      // synchronous step, before yielding to the publish. Two approvals clicked in
      // quick succession would otherwise both observe a fully-answered run after
      // their awaits and each wake the agent.
      answeredRef.current.add(callId);
      const runMessages = view.messages
        .filter((entry) => view.runOf(entry.codecMessageId)?.runId === target.runId)
        .map((entry) => entry.message);
      const answeredTheLastCall = unansweredCalls(runMessages).every((call) => answeredRef.current.has(call.call_id));

      const run = await view.send([input], { runId: target.runId });

      // Publish first, wake second: the agent reads the conversation off the
      // channel, so the resolution has to be there before the POST lands.
      if (answeredTheLastCall) onWake(run);
    },
    [view, onWake],
  );
}
