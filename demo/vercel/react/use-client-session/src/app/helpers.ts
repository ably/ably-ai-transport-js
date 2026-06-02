import type { ActiveRun } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';
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

/**
 * Wake the agent for a run by POSTing its invocation pointer to the agent
 * endpoint. The core ClientSession is a pure Ably transport — it never sends
 * HTTP — so the application owns this step. The agent rebuilds the pointer
 * with `Invocation.fromJSON` and reads the conversation from the channel.
 * @param api - The agent endpoint URL.
 * @param run - The run returned by `view.sendMessage` / `sendInput` / `regenerate` / `edit`.
 */
export async function wakeAgent(api: string, run: ActiveRun<VercelOutput>): Promise<void> {
  await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
}
