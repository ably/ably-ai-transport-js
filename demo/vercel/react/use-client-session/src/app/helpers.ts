import type { UIMessage } from 'ai';
import type { VercelEvent } from '@ably/ai-transport/vercel';

/** Construct a user UIMessage from a text string. */
export function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/** Construct a UserMessageEvent TEvent ready for view.send. */
export function userMessageEvent(text: string): VercelEvent {
  return { type: 'ait-user-message', message: userMessage(text) };
}
