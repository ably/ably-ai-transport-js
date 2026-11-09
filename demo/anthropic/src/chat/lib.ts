import type { Delivery } from '@ably/ai-transport';
import type { AnthropicEvent } from '@ably/ai-transport/anthropic';
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

/** A content block on the page: one the reducer built, or one a stored param holds. */
export type Block = ContentBlock | ContentBlockParam;

/** A client-side tool call, which the user approves or denies. */
export type ToolCall = ToolUseBlock | ToolUseBlockParam;

/** One message on the page: a client's input or one Message of a reply, under the id the store uses. */
export interface Entry {
  id: string;
  role: MessageParam['role'];
  content: string | Block[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * The `requestId` header the publishing call attached, read off the raw Ably
 * message. The client stamps it on its input and the route on every Message
 * of the reply, so every message of a turn carries the input's id.
 * @param message - The delivered Ably message.
 * @returns The request id, or `undefined` for a message without one.
 */
export const requestIdOf = (message: Delivery<AnthropicEvent>['message']): string | undefined => {
  const extras: unknown = message.extras;
  if (!isRecord(extras) || !isRecord(extras.headers)) return undefined;

  const { requestId } = extras.headers;

  return typeof requestId === 'string' ? requestId : undefined;
};

/** The entries for a client's input: one per message, `<requestId>:<n>`, as the route stores them. */
export const inputEntries = (requestId: string, messages: MessageParam[]): Entry[] =>
  messages.map((param, i) => ({ id: `${requestId}:${String(i)}`, role: param.role, content: param.content }));

/** The client-side tool calls in an entry. */
export const toolCallsOf = (entry: Entry | undefined): ToolCall[] =>
  entry?.role === 'assistant' && Array.isArray(entry.content)
    ? entry.content.filter((block) => block.type === 'tool_use')
    : [];
