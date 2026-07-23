import type { ClientRun } from '@ably/ai-transport';
import type { OpenAIInput, OpenAIMessage } from '@ably/ai-transport/openai';

import { toDisplayParts } from './display';

/**
 * Construct a user turn from a text string. Callers wrap it for the wire at the
 * call site, e.g. `view.send(ResponsesCodec.createUserMessage(userTurn(text)))`.
 * A user turn is a single input message carrying one `input_text` content part
 * (the shape the OpenAI input codec expects — see the codec's `inputs` table).
 */
export function userTurn(text: string): OpenAIMessage {
  return {
    role: 'user',
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  };
}

/**
 * Flatten a turn's message text: the `input_text` / `output_text` / `refusal`
 * content of its message items. Callers use it to seed the inline edit form and
 * to render plain (text-only) turns. It derives from {@link toDisplayParts},
 * keeping only the `text` parts; reasoning and tool parts contribute nothing.
 */
export function turnText(turn: OpenAIMessage): string {
  return toDisplayParts(turn)
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

/** Shape of the agent endpoint's JSON response. */
interface WakeAgentResult {
  /** The agent-minted run-id for this request (the agent mints it for a fresh run). */
  runId: string;
  /** The agent-minted invocation-id for this request. */
  invocationId: string;
}

/**
 * Wake the agent for a run by POSTing its invocation pointer to the agent
 * endpoint. The core ClientSession is a pure Ably transport — it never sends
 * HTTP — so the application owns this step. The agent rebuilds the pointer
 * with `Invocation.fromJSON`, reads the conversation from the channel, mints
 * the run-id (for a fresh run) and the invocation-id, and returns them on the
 * HTTP response. The same ids also arrive on the channel as `ai-run-start`,
 * which is how the client resolves `run.started` (populating `run.runId`)
 * without reading this response.
 * @param api - The agent endpoint URL.
 * @param run - The run returned by `view.send` / `regenerate` / `edit`.
 * @returns The agent-minted run-id and invocation-id read back from the response.
 * @throws If the endpoint responds with a non-JSON body (e.g. an error page).
 */
export async function wakeAgent(api: string, run: ClientRun<OpenAIInput, OpenAIMessage>): Promise<WakeAgentResult> {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
  // CAST: trust boundary — the agent route returns this shape.
  return (await response.json()) as WakeAgentResult;
}
