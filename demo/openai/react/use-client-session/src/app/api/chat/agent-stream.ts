/**
 * The agent's output stream — an agentic loop over OpenAI `/responses`.
 *
 * Server-executed tools don't suspend the run: the agent calls `/responses`,
 * and if the model emits function calls it runs them, publishes each result as
 * the codec's `function_call_output` output event, appends the model's output
 * items (reasoning items and the calls, in order) followed by the tool outputs
 * to the model input, and calls `/responses` again — looping until the model
 * stops calling tools (a final text reply). Re-appending the reasoning items,
 * not just the calls, matters for reasoning models: they expect the reasoning
 * that preceded a function_call to travel with it on the next request. All of
 * this rides one Ably run via a single `ReadableStream<OpenAIOutput>` piped
 * through `run.pipe`.
 *
 * This stream carries the raw `/responses` events plus the codec's own
 * `function_call_output` events (emitted here between turns). The route pipes
 * it to the run as-is; the codec's descriptor table curates the wire, dropping
 * the framing events no consumer reads and throwing on any genuinely
 * unexpected event.
 *
 * Function calls themselves need no synthesis: a `function_call` is a Responses
 * output item, so it arrives on the `response.output_item.added` /
 * `response.output_item.done` envelopes (the `done` carrying the complete
 * arguments) and is collected from there.
 */

import type { OpenAIOutput } from '@ably/ai-transport/openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { Responses } from 'openai/resources/responses/responses';

import { createResponseStream } from './model';
import { executeTool } from './tools';

/** Bound the loop so a misbehaving model can't spin forever (mirrors the Vercel demo's stepCountIs(10)). */
const MAX_STEPS = 10;

/** Inputs for one agent run's output stream. */
export interface AgentStreamRequest {
  /** The flattened conversation, ready for the first `/responses` `input` array. */
  input: Responses.ResponseInputItem[];
  /** The run's AbortSignal; aborting stops the loop and closes the stream cleanly. */
  signal: AbortSignal;
}

/**
 * Build the agent's combined output stream for a run, running the agentic loop
 * internally. Resolves each model turn, forwards its events, runs any tool
 * calls, and continues until the model produces a final reply with no tool
 * calls.
 * @param req - The initial conversation input and the run's abort signal.
 * @returns A stream of {@link OpenAIOutput} to pass to `run.pipe`.
 */
export function createAgentStream(req: AgentStreamRequest): ReadableStream<OpenAIOutput> {
  const input = [...req.input];
  const { signal } = req;

  return new ReadableStream<OpenAIOutput>({
    async start(controller) {
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (signal.aborted) break;

          const modelStream = await createResponseStream({ input, signal });
          const reader = modelStream.getReader();
          // Collect the model's completed output items in order. Function calls
          // are also picked out so the loop can run them; the client already sees
          // every item as it streams (via the enqueue in the loop below).
          const outputItems: Responses.ResponseOutputItem[] = [];
          const calls: Responses.ResponseFunctionToolCall[] = [];
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
              if (value.type === 'response.output_item.done') {
                outputItems.push(value.item);
                if (value.item.type === 'function_call') calls.push(value.item);
              }
            }
          } finally {
            reader.releaseLock();
          }

          // No tool calls (or aborted) → the model's reply is final. Done.
          if (calls.length === 0 || signal.aborted) break;

          // Feed the whole turn back before the tool results. Reasoning models
          // require the reasoning item(s) that preceded a function_call to travel
          // with the call on the next request, so re-append every output item in
          // order — this already includes the function_call itself, so it must
          // not be pushed again below.
          //
          // toResponseInputItems is the SDK's normalization of raw /responses
          // output items into replayable model input. ResponseOutputItem and
          // ResponseInputItem are distinct unions and neither is a subtype of the
          // other, so this bridges them without a cast — preserving reasoning
          // items (with their encrypted_content, for the stateless/ZDR round-trip)
          // and omitting any item that cannot be replayed.
          input.push(...toResponseInputItems(outputItems));

          // Run each tool and append its result. The calls themselves are already
          // in `input` via outputItems above, so only the outputs are added here.
          for (const call of calls) {
            const output = executeTool(call.name, call.arguments);
            const item: Responses.ResponseInputItem.FunctionCallOutput = {
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(output),
            };
            controller.enqueue({ type: 'function_call_output', item });
            input.push(item);
          }
        }
        controller.close();
      } catch (error) {
        // An abort surfaces as a stream error from the model SDK; treat it as a
        // clean close (the run-end is published by the route's cancel path).
        if (signal.aborted) controller.close();
        else controller.error(error);
      }
    },
  });
}
