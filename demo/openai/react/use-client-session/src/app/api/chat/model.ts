/**
 * Model selection for the agent route.
 *
 * Produces a `ReadableStream<ResponseStreamEvent>` for a request: the
 * deterministic mock behind `MOCK_LLM` (e2e tests), otherwise a real OpenAI
 * `/responses` stream. The default model is a non-reasoning model (`gpt-4.1`)
 * so the stream carries no reasoning events; the demo filters to the codec's
 * supported event types regardless (see `supported-events.ts`).
 */

import OpenAI from 'openai';
import type { Responses } from 'openai/resources/responses/responses';

import { createMockResponseStream } from './mock-model';

/** A request for one model turn. */
export interface ResponseStreamRequest {
  /** The flattened conversation, ready for the `/responses` `input` array. */
  input: Responses.ResponseInputItem[];
  /** The run's AbortSignal; aborting cancels the model stream. */
  signal: AbortSignal;
}

/**
 * Open a model stream for a request. Resolves to a `ReadableStream` of raw
 * Responses events, ready to filter and pipe.
 * @throws If neither `MOCK_LLM` nor `OPENAI_API_KEY` is configured.
 */
export async function createResponseStream(
  req: ResponseStreamRequest,
): Promise<ReadableStream<Responses.ResponseStreamEvent>> {
  if (process.env.MOCK_LLM) {
    return createMockResponseStream(req);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('No model configured. Set OPENAI_API_KEY (or MOCK_LLM=1 for the deterministic mock).');
  }

  const client = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1';

  const stream = await client.responses.create({ model, input: req.input, stream: true }, { signal: req.signal });
  return iterableToStream(stream, req.signal);
}

/**
 * Adapt the OpenAI SDK's async-iterable stream into a `ReadableStream`. On abort
 * the stream closes cleanly (the underlying request is already aborted via the
 * signal passed to `responses.create`), so the pipe sees a normal end.
 */
function iterableToStream(
  iterable: AsyncIterable<Responses.ResponseStreamEvent>,
  signal: AbortSignal,
): ReadableStream<Responses.ResponseStreamEvent> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Responses.ResponseStreamEvent>({
    async pull(controller) {
      if (signal.aborted) {
        await iterator.return?.();
        controller.close();
        return;
      }
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
