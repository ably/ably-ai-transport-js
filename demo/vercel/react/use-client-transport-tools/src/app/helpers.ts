import type { UIMessage } from 'ai';

/** Construct a user UIMessage from a text string. */
export function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/** Payload sent in SendOptions.body when approving/denying a tool call. */
export interface ToolApproval {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  approved: boolean;
}
