/** Shared test helpers for the chat API route's model/stream tests. */

import type { Responses } from 'openai/resources/responses/responses';

/** A single-message conversation input carrying one user text part. */
export function userInput(text: string): Responses.ResponseInputItem[] {
  return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
}

/** Read a stream to completion and collect its values in order. */
export async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}
