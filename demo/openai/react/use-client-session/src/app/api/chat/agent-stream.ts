/**
 * The agent's output stream — an agentic loop over OpenAI `/responses`.
 *
 * Server-executed tools don't suspend the run: the agent calls `/responses`,
 * and if the model emits function calls it runs them, publishes each result as
 * the codec's `function_call_output` output event, appends the call + output to
 * the model input, and calls `/responses` again — looping until the model
 * stops calling tools (a final text reply). All of this rides one Ably run via
 * a single `ReadableStream<OpenAIOutput>` piped through `run.pipe`.
 *
 * The raw `/responses` stream is piped straight through — no pre-filtering. The
 * codec encodes what it models and silently drops the handful of events it
 * doesn't yet stream (its `ignore` list, e.g. the function-call argument
 * deltas), while still throwing on any genuinely unexpected event. The
 * synthesised `function_call_output` events are the codec's own output type,
 * emitted here between turns.
 *
 * Function calls themselves need no synthesis: a `function_call` is a Responses
 * output item, so it arrives on the `response.output_item.added` /
 * `response.output_item.done` envelopes (the `done` carrying the complete
 * arguments) and is collected from there.
 */

import type { OpenAIOutput } from '@ably/ai-transport/openai';
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
          const calls: Responses.ResponseFunctionToolCall[] = [];
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
              // Collect completed function calls; the done envelope carries the
              // full arguments. The client already sees the call via this event.
              if (value.type === 'response.output_item.done' && value.item.type === 'function_call') {
                calls.push(value.item);
              }
            }
          } finally {
            reader.releaseLock();
          }

          // No tool calls (or aborted) → the model's reply is final. Done.
          if (calls.length === 0 || signal.aborted) break;

          // Run each tool, publish its result, and feed call + output back in.
          for (const call of calls) {
            const output = executeTool(call.name, call.arguments);
            const item: Responses.ResponseInputItem.FunctionCallOutput = {
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(output),
            };
            controller.enqueue({ type: 'function_call_output', item });
            input.push(call, item);
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
