import type { UIMessage } from 'ai';
import type { VercelInput } from '@ably/ai-transport/vercel';

/** Construct a user UIMessage from a text string. */
export function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/** Construct a UserMessage TInput ready for view.sendEvent. */
export function userMessageEvent(text: string): VercelInput {
  return { kind: 'user-message', message: userMessage(text) };
}
