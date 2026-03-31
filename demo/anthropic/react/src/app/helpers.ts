import type { AgentMessage } from '@ably/ai-transport/anthropic';

/** Construct a user AgentMessage from a text string. */
export function userMessage(text: string): AgentMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}
