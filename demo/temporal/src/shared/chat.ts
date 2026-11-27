/**
 * What the page, the API route and the workflow agree on. Workflow code
 * imports this too, so it holds constants and types only.
 */

import type { ModelMessage } from 'ai';

/** The task queue the worker polls, for the chat workflows and the relay. */
export const TASK_QUEUE = 'ai-transport-temporal-demo';

/** The signal the API route sends a chat workflow, once per turn. */
export const TURN_SIGNAL = 'turn';

/** One turn of the conversation, as the API route signals it to the workflow. */
export interface Turn {
  /** The id of the reply, which the workflow's `start` chunk carries. */
  messageId: string;
  /** The whole conversation so far, the new user message last. */
  messages: ModelMessage[];
}

/** What a chat workflow starts with. */
export interface ChatInput {
  /** The Ably channel the relay publishes the replies to. */
  channelName: string;
}

/**
 * The channel a chat streams on. The `ai` namespace carries the
 * `mutableMessages` rule that appends need.
 * @param chatId - The chat's id.
 * @returns The channel name.
 */
export const channelNameOf = (chatId: string): string => `ai:temporal:${chatId}`;
