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
 * which is how the client resolves `run.runId` without reading this response.
 * @param api - The agent endpoint URL.
 * @param run - The run returned by `view.sendMessage` / `sendInput` / `regenerate` / `edit`.
 * @returns The agent-minted run-id and invocation-id read back from the response.
 * @throws If the endpoint responds with a non-JSON body (e.g. an error page).
 */
export async function wakeAgent(api: string, run: ActiveRun): Promise<WakeAgentResult> {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
  // CAST: trust boundary — the agent route returns this shape.
  return (await response.json()) as WakeAgentResult;
}
