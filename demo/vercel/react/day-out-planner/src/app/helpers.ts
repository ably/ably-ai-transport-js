import type { ActiveRun } from '@ably/ai-transport';
import type { UIMessage } from 'ai';

/** Construct a user UIMessage from a text string. */
export function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/** Whether a message is addressed to Bernard (case-insensitive `@bernard`). */
export function mentionsBernard(text: string): boolean {
  return /@bernard\b/i.test(text);
}

/**
 * Wake the agent by POSTing a freshly-sent run's invocation to the agent
 * endpoint. The client session publishes messages on the channel but never
 * sends HTTP itself: triggering the agent is the application's choice. This is
 * how a durable session lets the app decide *when* the agent does work — here,
 * only when a message mentions `@bernard`.
 */
export async function wakeAgent(api: string, run: ActiveRun): Promise<void> {
  await fetch(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
}
