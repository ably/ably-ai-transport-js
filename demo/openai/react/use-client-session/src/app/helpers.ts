import type { ClientRun } from '@ably/ai-transport';
import type { OpenAIItem, OpenAITurn } from '@ably/ai-transport/openai';

/**
 * Construct a user turn from a text string. Callers wrap it for the wire at the
 * call site, e.g. `view.send(ResponsesCodec.createUserMessage(userTurn(text)))`.
 * A user turn is a single input message carrying one `input_text` content part
 * (the shape the OpenAI input codec expects — see the codec's `inputs` table).
 */
export function userTurn(text: string): OpenAITurn {
  return {
    role: 'user',
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  };
}

/** Flatten a message item's content parts into rendered text (empty for non-message items). */
function messageItemText(item: OpenAIItem): string {
  if (item.type !== 'message') return '';
  const content = item.content;
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type === 'output_text' || part.type === 'input_text') text += part.text;
    else if (part.type === 'refusal') text += part.refusal;
  }
  return text;
}

/**
 * Flatten a turn's items into their rendered text — the `input_text` /
 * `output_text` content parts of its message items, plus any `refusal`. Used to
 * seed the inline edit form and to render plain (text-only) turns. Tool items
 * contribute nothing here; {@link toRenderItems} renders those.
 */
export function turnText(turn: OpenAITurn): string {
  let text = '';
  for (const item of turn.items) text += messageItemText(item);
  return text;
}

/**
 * A renderable part of a turn: a run of message text, or a server-side tool
 * interaction (the `getWeather` call and, once it has arrived, its result).
 */
export type RenderPart =
  | {
      /** A run of assistant/user message text. */
      kind: 'text';
      /** The text content. */
      text: string;
    }
  | {
      /** A server-side tool call. */
      kind: 'tool';
      /** The tool call's id, correlating the call with its output. */
      callId: string;
      /** The tool name (e.g. `getWeather`). */
      name: string;
      /** The call arguments as a JSON string (complete once the call is done). */
      args: string;
      /** The tool's output as a JSON string, or `undefined` while still running. */
      output?: string;
    };

/**
 * Project a turn's items into render parts in item order, pairing each
 * `function_call` with its matching `function_call_output` (by `call_id`,
 * order-independent) so a tool interaction renders as one part. The output item
 * is dropped from the flat stream — it is shown attached to its call.
 */
export function toRenderItems(turn: OpenAITurn): RenderPart[] {
  const outputByCallId = new Map<string, string>();
  for (const item of turn.items) {
    if (item.type === 'function_call_output') {
      outputByCallId.set(item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
    }
  }

  const parts: RenderPart[] = [];
  for (const item of turn.items) {
    if (item.type === 'function_call') {
      parts.push({
        kind: 'tool',
        callId: item.call_id,
        name: item.name,
        args: item.arguments,
        output: outputByCallId.get(item.call_id),
      });
    } else if (item.type === 'message') {
      const text = messageItemText(item);
      if (text) parts.push({ kind: 'text', text });
    }
    // function_call_output is shown with its call; other item types are not
    // yet rendered.
  }
  return parts;
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
export async function wakeAgent(api: string, run: ClientRun<OpenAITurn>): Promise<WakeAgentResult> {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
  // CAST: trust boundary — the agent route returns this shape.
  return (await response.json()) as WakeAgentResult;
}
