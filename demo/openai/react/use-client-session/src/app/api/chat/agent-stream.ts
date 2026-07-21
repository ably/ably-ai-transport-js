/**
 * The agent's agentic loop over OpenAI `/responses`, publishing each unit of
 * work as its own message.
 *
 * Server-executed tools don't suspend the run: the agent calls `/responses`,
 * and if the model emits function calls it runs them, appends the model's
 * output items (reasoning items and the calls, in order) followed by the tool
 * outputs to the model input, and calls `/responses` again — looping until the
 * model stops calling tools (a final text reply). Re-appending the reasoning
 * items, not just the calls, matters for reasoning models: they expect the
 * reasoning that preceded a function_call to travel with it on the next
 * request.
 *
 * Each unit of work is published under its own `run.pipe`, so each gets a fresh
 * `codec-message-id` and the codec's reducer keys it as a distinct
 * `OpenAIMessage`. One model turn is one message; the batch of tool outputs for
 * that turn is a second message. A run that calls one tool therefore produces
 * three messages: the turn that emitted the calls, the tool outputs, and the
 * final text turn. This is the agent's choice of chunking — the codec is
 * agnostic, keying messages purely by `codec-message-id`.
 *
 * The `function_call_output` events land in their own message (rule B): the
 * codec folds them by `codec-message-id`, not by `call_id`, so a renderer pairs
 * a call with its output across messages by `call_id`.
 *
 * Each piped stream carries the raw `/responses` events (model turn) or the
 * codec's own `function_call_output` events (tool outputs). The codec's
 * descriptor table curates the wire, dropping the framing events no consumer
 * reads and throwing on any genuinely unexpected event.
 */

import type { AgentRun, StreamResult } from '@ably/ai-transport';
import type { OpenAIMessage, OpenAIOutput, OpenAIProjection } from '@ably/ai-transport/openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { Responses } from 'openai/resources/responses/responses';

import { createResponseStream } from './model';
import { executeTool } from './tools';

/** Bound the loop so a misbehaving model can't spin forever (mirrors the Vercel demo's stepCountIs(10)). */
const MAX_STEPS = 10;

/** The publishing surface the loop drives — one `pipe` call per message. */
type AgentLoopRun = Pick<AgentRun<OpenAIOutput, OpenAIProjection, OpenAIMessage>, 'pipe' | 'abortSignal'>;

/** Inputs for one agent run's loop. */
export interface AgentLoopRequest {
  /** The run to publish under; each `pipe` mints a fresh message. */
  run: AgentLoopRun;
  /** The flattened conversation, ready for the first `/responses` `input` array. */
  input: Responses.ResponseInputItem[];
}

/** What one model `/responses` turn produced, collected as its stream drains. */
interface ModelTurn {
  /** The turn's completed output items, in order (reasoning items and calls). */
  outputItems: Responses.ResponseOutputItem[];
  /** The function calls the model emitted this turn, if any. */
  calls: Responses.ResponseFunctionToolCall[];
}

/**
 * Build the stream for one model `/responses` turn, collecting its completed
 * output items into `turn` as the stream drains so the loop can decide whether
 * to run tools and continue.
 */
function createModelTurnStream(
  input: Responses.ResponseInputItem[],
  signal: AbortSignal,
  turn: ModelTurn,
): ReadableStream<OpenAIOutput> {
  return new ReadableStream<OpenAIOutput>({
    async start(controller) {
      try {
        const modelStream = await createResponseStream({ input, signal });
        const reader = modelStream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            if (value.type === 'response.output_item.done') {
              turn.outputItems.push(value.item);
              if (value.item.type === 'function_call') turn.calls.push(value.item);
            }
          }
        } finally {
          reader.releaseLock();
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

/** Build a stream that publishes the given tool outputs as one message, then closes. */
function createToolOutputStream(outputs: OpenAIOutput[]): ReadableStream<OpenAIOutput> {
  return new ReadableStream<OpenAIOutput>({
    start(controller) {
      for (const output of outputs) controller.enqueue(output);
      controller.close();
    },
  });
}

/**
 * Run the agentic loop, publishing each unit of work under its own `run.pipe`.
 * Resolves each model turn as its own message, runs any tool calls and
 * publishes their outputs as a second message, and continues until the model
 * produces a final reply with no tool calls.
 * @param req - The run handle and the initial conversation input.
 * @returns The aggregate {@link StreamResult}: `error` if any pipe failed.
 */
export async function runAgentLoop(req: AgentLoopRequest): Promise<StreamResult> {
  const input = [...req.input];
  const { run } = req;
  let terminalError: Error | undefined;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (run.abortSignal.aborted) break;

    // One model /responses turn = one assistant message.
    const turn: ModelTurn = { outputItems: [], calls: [] };
    const modelResult = await run.pipe(createModelTurnStream(input, run.abortSignal, turn));
    if (modelResult.error) terminalError = modelResult.error;

    // No tool calls (or aborted) → the model's reply is final. Done.
    if (turn.calls.length === 0 || run.abortSignal.aborted) break;

    // Feed the whole turn back before the tool results. Reasoning models
    // require the reasoning item(s) that preceded a function_call to travel
    // with the call on the next request, so re-append every output item in
    // order — this already includes the function_call itself, so it must not be
    // pushed again below.
    //
    // toResponseInputItems is the SDK's normalization of raw /responses output
    // items into replayable model input. ResponseOutputItem and
    // ResponseInputItem are distinct unions and neither is a subtype of the
    // other, so this bridges them without a cast — preserving reasoning items
    // (with their encrypted_content, for the stateless/ZDR round-trip) and
    // omitting any item that cannot be replayed.
    input.push(...toResponseInputItems(turn.outputItems));

    // Run each tool and publish its result. The calls themselves are already in
    // `input` via outputItems above, so only the outputs are added here. The
    // whole batch rides one pipe, so it lands in its own message.
    const toolOutputs = turn.calls.map(
      (call): Responses.ResponseInputItem.FunctionCallOutput => ({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(executeTool(call.name, call.arguments)),
      }),
    );
    const toolResult = await run.pipe(
      createToolOutputStream(toolOutputs.map((item) => ({ type: 'function_call_output', item }))),
    );
    if (toolResult.error) terminalError = toolResult.error;
    for (const item of toolOutputs) input.push(item);
  }

  return terminalError ? { reason: 'error', error: terminalError } : { reason: 'complete' };
}
