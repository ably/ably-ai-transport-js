/**
 * The agent's agentic loop over OpenAI `/responses`, publishing each unit of
 * work as its own message and suspending the run when a tool call needs the
 * client.
 *
 * Server-executed tools (getWeather) don't suspend: the agent calls
 * `/responses`, and if the model emits function calls it runs them, appends the
 * model's output items (reasoning items and the calls, in order) followed by the
 * tool outputs to the model input, and calls `/responses` again — looping until
 * the model stops calling tools (a final text reply). Re-appending the reasoning
 * items, not just the calls, matters for reasoning models: they expect the
 * reasoning that preceded a function_call to travel with it on the next request.
 *
 * A client-executed tool (getLocation) or an approval-gated tool
 * (getWeatherForecast) cannot be resolved here, so the loop suspends the run:
 * for a gated call it emits a `tool-approval-request` on the call's own message
 * (the tail of the model turn's pipe) before suspending. The client
 * resolves the call — running the browser tool and publishing its
 * `function_call_output`, or answering the approval — then sends a continuation that resumes this run
 * under the same runId. On resume the loop re-hydrates the conversation: a
 * client `function_call_output` (or a denial's rejection output) is already
 * folded into the model input, and an approved-but-unexecuted gated call is run
 * server-side here before the next model turn.
 *
 * Each unit of work is published under its own `run.pipe`, so each gets a fresh
 * `codec-message-id` and a consumer's fold keys it as a distinct
 * `OpenAIMessage`. One model turn is one message; the batch of tool outputs for
 * that turn is a second message. A run that calls one tool therefore produces
 * three messages: the turn that emitted the calls, the tool outputs, and the
 * final text turn. This is the agent's choice of chunking — the codec is
 * agnostic, keying messages purely by `codec-message-id`.
 *
 * The `function_call_output` events land in their own message: a consumer folds
 * them by `codec-message-id` alone, so a renderer pairs a call with its output
 * across messages by `call_id`.
 *
 * Each piped stream carries the raw `/responses` events (model turn) or the
 * codec's own `function_call_output` events (tool outputs). The codec's
 * descriptor table curates the wire, dropping the framing events no consumer
 * reads and throwing on any genuinely unexpected event.
 */

import Ably from 'ably';
import type { AgentRunTransport, RunEndParams, StreamResult } from '@ably/ai-transport';
import { ErrorCode } from '@ably/ai-transport';
import type { OpenAIMessage, OpenAIOutput } from '@ably/ai-transport/openai';
import { approvedUnexecutedCalls } from '@ably/ai-transport/openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { Responses } from 'openai/resources/responses/responses';

import { createResponseStream } from './model';
import { executeTool, isClientTool, needsApproval } from './tools';

/** Bound the loop so a misbehaving model can't spin forever (mirrors the Vercel demo's stepCountIs(10)). */
const MAX_STEPS = 10;

/** The publishing surface the loop drives — one `pipe` call per message. */
type AgentLoopRun = Pick<AgentRunTransport<OpenAIOutput>, 'pipe' | 'abortSignal'>;

/** Inputs for one agent run's loop. */
export interface AgentLoopRequest {
  /** The run to publish under; each `pipe` mints a fresh message. */
  run: AgentLoopRun;
  /** The flattened conversation, ready for the first `/responses` `input` array. */
  input: Responses.ResponseInputItem[];
  /**
   * The hydrated conversation as codec messages, carrying `toolCallStates`. Read
   * on resume to find an approved-but-unexecuted gated call the agent must run
   * server-side before the next model turn.
   */
  priorMessages: OpenAIMessage[];
}

/**
 * How the loop ended. For the `suspend` arm a client-executed or approval-gated
 * tool paused the run awaiting the client, and the route maps it onto
 * `run.suspend()`. Every other arm is a {@link RunEndParams} the route forwards
 * to `run.end()` directly: `complete` when the model produced a final reply, or
 * `error` when a pipe failed, carrying the failure as an `Ably.ErrorInfo`.
 */
export type AgentLoopOutcome = { reason: 'suspend' } | RunEndParams;

/** What one model `/responses` turn produced, collected as its stream drains. */
interface ModelTurn {
  /** The turn's completed output items, in order (reasoning items and calls). */
  outputItems: Responses.ResponseOutputItem[];
  /** The function calls the model emitted this turn, if any. */
  calls: Responses.ResponseFunctionToolCall[];
}

/**
 * The output source for one model `/responses` turn, collecting its completed
 * output items into `turn` as it drains so the loop can decide whether to run
 * tools and continue. `run.pipe` consumes this async-iterable directly.
 */
async function* modelTurnStream(
  input: Responses.ResponseInputItem[],
  signal: AbortSignal,
  turn: ModelTurn,
): AsyncGenerator<OpenAIOutput> {
  try {
    for await (const value of await createResponseStream({ input, signal })) {
      yield value;
      if (value.type === 'response.output_item.done') {
        turn.outputItems.push(value.item);
        if (value.item.type === 'function_call') turn.calls.push(value.item);
      }
    }
  } catch (error) {
    // An abort surfaces as a stream error from the model SDK; treat it as a
    // clean end (the run-end is published by the route's cancel path).
    if (!signal.aborted) throw error;
  }
}

/** The output source that publishes the given events as one message. */
async function* outputStream(outputs: OpenAIOutput[]): AsyncGenerator<OpenAIOutput> {
  for (const output of outputs) yield output;
}

/**
 * The model turn followed by a `tool-approval-request` for each gated call it
 * emitted, all on one pipe. Emitting the request as the tail of the model turn's
 * own pipe puts it on the SAME `codec-message-id` as the `function_call` it
 * gates, so the request's `approval: 'pending'` state, the client's
 * `tool-approval-response` decision (addressed to that message), and the
 * `function_call` itself all fold onto one message. Publishing the request as a
 * separate message would strand the pending state on a message the response
 * never amends — the approval card would never resolve, and the resume-side
 * {@link approvedUnexecutedCalls} (which pairs a call with its approval on one
 * message) would never see an approved call.
 */
async function* modelTurnWithGateRequests(
  input: Responses.ResponseInputItem[],
  signal: AbortSignal,
  turn: ModelTurn,
): AsyncGenerator<OpenAIOutput> {
  yield* modelTurnStream(input, signal, turn);
  for (const call of turn.calls) {
    if (needsApproval(call.name)) {
      yield { type: 'tool-approval-request', call_id: call.call_id, name: call.name, arguments: call.arguments };
    }
  }
}

/** Run a batch of server tool calls and wrap each result as a `function_call_output` event. */
function runToolCalls(calls: Responses.ResponseFunctionToolCall[]): {
  items: Responses.ResponseInputItem.FunctionCallOutput[];
  events: OpenAIOutput[];
} {
  const items = calls.map(
    (call): Responses.ResponseInputItem.FunctionCallOutput => ({
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify(executeTool(call.name, call.arguments)),
    }),
  );
  return { items, events: items.map((item) => ({ type: 'function_call_output', item })) };
}

/**
 * Run the agentic loop, publishing each unit of work under its own `run.pipe`.
 * Runs any server tool inline and continues; suspends the run when a
 * client-executed or approval-gated tool needs the client, emitting a
 * `tool-approval-request` on a gated call's own message first. On resume it
 * completes an approved gated call server-side before continuing.
 * @param req - The run handle, initial conversation input, and hydrated messages.
 * @returns The loop's {@link AgentLoopOutcome}.
 */
export async function runAgentLoop(req: AgentLoopRequest): Promise<AgentLoopOutcome> {
  const input = [...req.input];
  const { run } = req;
  let terminalError: Ably.ErrorInfo | undefined;
  const fail = (result: StreamResult): void => {
    if (result.error) {
      terminalError = new Ably.ErrorInfo(
        `unable to complete run; ${result.error.message}`,
        ErrorCode.RunResponseStreamFailed,
        500,
      );
    }
  };

  // Resume completion: a gated call the user just approved has a function_call
  // in the hydrated conversation but no output yet. Run it server-side, publish
  // the output as its own message, and feed it back before the next model turn.
  const approved = approvedUnexecutedCalls(req.priorMessages);
  if (approved.length > 0) {
    const { items, events } = runToolCalls(approved);
    fail(await run.pipe(outputStream(events)));
    input.push(...items);
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    if (run.abortSignal.aborted) break;

    // One model /responses turn = one assistant message. A gated call's
    // approval request rides this same message (see modelTurnWithGateRequests).
    const turn: ModelTurn = { outputItems: [], calls: [] };
    fail(await run.pipe(modelTurnWithGateRequests(input, run.abortSignal, turn)));

    // No tool calls (or aborted) → the model's reply is final. Done.
    if (turn.calls.length === 0 || run.abortSignal.aborted) break;

    // Feed the whole turn back before any tool results. Reasoning models require
    // the reasoning item(s) that preceded a function_call to travel with the call
    // on the next request, so re-append every output item in order — this already
    // includes the function_call itself. toResponseInputItems normalises raw
    // /responses output items into replayable model input, bridging the distinct
    // ResponseOutputItem / ResponseInputItem unions without a cast.
    input.push(...toResponseInputItems(turn.outputItems));

    // Partition the turn's calls by how they resolve.
    const serverCalls = turn.calls.filter((call) => !isClientTool(call.name) && !needsApproval(call.name));
    const clientCalls = turn.calls.filter((call) => isClientTool(call.name));
    const gatedCalls = turn.calls.filter((call) => needsApproval(call.name));

    // Server-executable tools run inline and their outputs feed the next turn.
    if (serverCalls.length > 0) {
      const { items, events } = runToolCalls(serverCalls);
      fail(await run.pipe(outputStream(events)));
      input.push(...items);
    }

    // A gated call needs a human decision; a client call runs in the browser.
    // Either way the run can't proceed here — the gated calls' approval requests
    // already rode the model turn's message, so suspend and let a continuation
    // resume once the client answers.
    if (gatedCalls.length > 0 || clientCalls.length > 0) {
      return terminalError ? { reason: 'error', error: terminalError } : { reason: 'suspend' };
    }

    // Only server tools this turn — loop for the next model turn.
  }

  return terminalError ? { reason: 'error', error: terminalError } : { reason: 'complete' };
}
