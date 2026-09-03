/** Shared test helpers for the chat API route's model/stream tests. */

import type { Responses } from 'openai/resources/responses/responses';

/** A single-message conversation input carrying one user text part. */
export function userInput(text: string): Responses.ResponseInputItem[] {
  return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
}

/** Read an async-iterable source to completion and collect its values in order. */
export async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}
