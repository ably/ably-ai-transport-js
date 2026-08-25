import type { UIMessage } from 'ai';

/**
 * Construct a user UIMessage from a text string, ready to publish as a
 * `{ kind: 'message' }` input or hand to useChat's `sendMessage`.
 */
export function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/**
 * The invocation pointer the chat route expects: which channel to read, the
 * input event that triggered the invocation, and the run to continue (absent
 * for a fresh run — the agent mints the run-id).
 */
export interface WakeAgentBody {
  /** The Ably channel the conversation lives on. */
  channelName: string;
  /** The `event-id` of the triggering input event on the channel. */
  eventId: string;
  /** The run to continue; omit for a fresh run. */
  runId?: string;
}

/** Shape of the chat route's JSON response. */
export interface WakeAgentResult {
  /** The run-id for this invocation (agent-minted for a fresh run). */
  runId: string;
}

/**
 * Wake the agent by POSTing an invocation pointer to the chat route. The
 * client transport is a pure Ably transport — it never sends HTTP — so the
 * application owns this step. The agent reads the conversation from the
 * channel, waits for the pointed-at input event, and returns the run-id on
 * the HTTP response. The same run-id also arrives on the channel as
 * `ai-run-start`.
 * @param api - The chat route URL.
 * @param body - The invocation pointer to POST.
 * @returns The run-id read back from the response.
 * @throws If the endpoint responds with a non-JSON body (e.g. an error page).
 */
export async function wakeAgent(api: string, body: WakeAgentBody): Promise<WakeAgentResult> {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // CAST: trust boundary — the chat route returns this shape.
  return (await response.json()) as WakeAgentResult;
}
