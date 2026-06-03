import type { ActiveRun } from '@ably/ai-transport';
import type { VercelInput } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';

/** Construct a user UIMessage from a text string. */
export function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/** Construct a UserMessage TInput ready for view.sendInput. */
export function userMessageEvent(text: string): VercelInput {
  return { kind: 'user-message', message: userMessage(text) };
}

/** Shape of the agent endpoint's JSON response. */
interface WakeAgentResult {
  /** The agent-minted invocation-id for this request. */
  invocationId: string;
}

/**
 * Wake the agent for a run by POSTing its invocation pointer to the agent
 * endpoint. The core ClientSession is a pure Ably transport — it never sends
 * HTTP — so the application owns this step. The agent rebuilds the pointer
 * with `Invocation.fromJSON`, reads the conversation from the channel, mints
 * the invocation-id, and returns it on the HTTP response.
 * @param api - The agent endpoint URL.
 * @param run - The run returned by `view.sendMessage` / `sendInput` / `regenerate` / `edit`.
 * @returns The agent-minted invocation-id read back from the response.
 * @throws If the endpoint responds with a non-JSON body (e.g. an error page).
 */
export async function wakeAgent(api: string, run: ActiveRun): Promise<string> {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
  // CAST: trust boundary — the agent route returns this shape.
  const { invocationId } = (await response.json()) as WakeAgentResult;
  return invocationId;
}
