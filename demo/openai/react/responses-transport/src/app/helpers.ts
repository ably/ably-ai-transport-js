import type { OpenAIMessage } from './lib/openai-thread';

import { toDisplayParts } from './display';

/**
 * Construct a user turn from a text string. Callers wrap it for the wire at
 * the call site, e.g.
 * `transport.publishInput({ kind: 'message', payload: userTurn(text) })`.
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
 * content of its message items. Callers use it to render plain (text-only)
 * turns. It derives from {@link toDisplayParts}, keeping only the `text`
 * parts; reasoning and tool parts contribute nothing.
 */
export function turnText(turn: OpenAIMessage): string {
  return toDisplayParts(turn)
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

/** The JSON body the demo POSTs to the agent endpoint to wake it. */
export interface WakeAgentBody {
  /** The Ably channel the conversation lives on. */
  channelName: string;
  /** The published input's `event-id` — what the agent's `locateInput` matches to find the trigger. */
  eventId: string;
}

/**
 * Wake the agent by POSTing the published input's pointer to the agent
 * endpoint. The client transport is a pure Ably transport — it never sends
 * HTTP — so the application owns this step. The agent locates the input on the
 * channel by `eventId`, rebuilds the conversation from channel history, and
 * opens the run.
 *
 * Nothing is read from the response: the run id arrives on the channel as
 * `ai-run-start`, which is how the thread fold tracks the run. A failed wake
 * still has to surface, though — the input is already published, so a silent
 * failure looks exactly like a message the agent is slow to answer.
 * @param api - The agent endpoint URL.
 * @param body - The wake pointer; see {@link WakeAgentBody}.
 * @returns Resolves once the endpoint has accepted the wake.
 * @throws If the endpoint responds with a non-2xx status.
 */
export async function wakeAgent(api: string, body: WakeAgentBody): Promise<void> {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`wake POST to ${api} failed with ${String(response.status)}${detail ? `: ${detail}` : ''}`);
  }
}
