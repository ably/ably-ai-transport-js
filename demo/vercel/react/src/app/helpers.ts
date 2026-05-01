import type * as AI from 'ai';

/** Build the session name from optional namespace + base name. */
export function resolveSessionName(base: string, namespace?: string): string {
  return namespace !== undefined && namespace.length > 0 ? `${namespace}:${base}` : base;
}

/** Construct a user UIMessage from a text string. */
export function userMessage(text: string): AI.UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/** Concatenate every text part on a UIMessage. */
export function messageText(message: AI.UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
