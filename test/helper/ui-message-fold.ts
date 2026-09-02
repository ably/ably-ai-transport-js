/** Fold decoded Vercel chunks through the provider's own reducer. */

import * as AI from 'ai';

/**
 * Fold a chunk sequence through the provider's own reducer
 * (`readUIMessageStream`) and return the final message state. The reducer is
 * strict — a delta with no opener, or an end for an id it holds no open part
 * for, throws — so folding through it proves a decoded sequence is one the
 * provider's own machinery accepts.
 * @param chunks - The chunks, in wire order.
 * @returns The last message state `readUIMessageStream` yields.
 */
export const foldWithProviderReducer = async (chunks: AI.UIMessageChunk[]): Promise<AI.UIMessage | undefined> => {
  const stream = new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: AI.UIMessage | undefined;
  for await (const message of AI.readUIMessageStream({ stream })) {
    last = message;
  }
  return last;
};
