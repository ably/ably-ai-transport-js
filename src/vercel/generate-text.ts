/**
 * Convert a Vercel AI SDK `generateText` (one-shot) result into the stream of
 * `UIMessageChunk`s that represents it.
 *
 * `generateText` returns a complete result with no streaming representation,
 * and the AI SDK ships no `result → UIMessageChunk` / `result → UIMessage`
 * converter. This module provides one: it is the `generateText` analogue of a
 * `streamText` result's `toUIMessageStream()`. Feed the returned stream
 * straight to `Run.pipe` to publish a one-shot response over the transport —
 * the operation itself is Ably-agnostic.
 */

import type * as AI from 'ai';

/**
 * The subset of a `generateText` result the converter reads. A real
 * `AI.GenerateTextResult` satisfies this structurally, so callers pass their
 * result directly without naming its `OUTPUT` type parameter.
 */
interface OneShotResult<TOOLS extends AI.ToolSet> {
  /** The generation steps, in order; each carries the content it produced. */
  readonly steps: readonly AI.StepResult<TOOLS>[];
  /** The unified reason the generation finished. */
  readonly finishReason: AI.FinishReason;
}

/**
 * Build the `UIMessageChunk` sequence representing a `generateText` result.
 *
 * The sequence mirrors what `streamText().toUIMessageStream()` would have
 * produced for the same content: a leading `start`, then for each generation
 * step a `start-step` / `finish-step` pair wrapping the step's content parts in
 * order, then a trailing `finish` carrying the result's `finishReason`. A
 * consumer (e.g. `useChat`) therefore reconstructs the same `UIMessage` it
 * would from a streamed response.
 *
 * Text and reasoning parts are emitted as a degenerate single-delta stream
 * (`*-start` → one `*-delta` carrying the full text → `*-end`). Tool calls and
 * tool results are emitted as their complete (non-streamed) chunks. Optional
 * fidelity not yet carried by this one-shot path: provider metadata, the
 * `dynamic` / `providerExecuted` / `preliminary` flags, and `file` / `source`
 * parts.
 * @param result - The `generateText` result to convert.
 * @returns The ordered `UIMessageChunk`s representing the result.
 */
const toUIMessageChunks = <TOOLS extends AI.ToolSet>(result: OneShotResult<TOOLS>): AI.UIMessageChunk[] => {
  const chunks: AI.UIMessageChunk[] = [{ type: 'start' }];

  // Unique within the message — correlates each text/reasoning block's
  // start/delta/end triple. A monotonic counter is sufficient.
  let streamId = 0;

  for (const step of result.steps) {
    chunks.push({ type: 'start-step' });

    for (const part of step.content) {
      switch (part.type) {
        case 'text': {
          const id = `text-${String(streamId++)}`;
          chunks.push(
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: part.text },
            { type: 'text-end', id },
          );
          break;
        }
        case 'reasoning': {
          const id = `reasoning-${String(streamId++)}`;
          chunks.push(
            { type: 'reasoning-start', id },
            { type: 'reasoning-delta', id, delta: part.text },
            { type: 'reasoning-end', id },
          );
          break;
        }
        case 'tool-call': {
          chunks.push({
            type: 'tool-input-available',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        }
        case 'tool-result': {
          chunks.push({ type: 'tool-output-available', toolCallId: part.toolCallId, output: part.output });
          break;
        }
        case 'tool-error': {
          chunks.push({
            type: 'tool-output-error',
            toolCallId: part.toolCallId,
            errorText: part.error instanceof Error ? part.error.message : String(part.error),
          });
          break;
        }
        case 'tool-approval-request': {
          chunks.push({
            type: 'tool-approval-request',
            toolCallId: part.toolCall.toolCallId,
            approvalId: part.approvalId,
          });
          break;
        }
        case 'source':
        case 'file': {
          // Not yet converted for the one-shot path.
          break;
        }
      }
    }

    chunks.push({ type: 'finish-step' });
  }

  chunks.push({ type: 'finish', finishReason: result.finishReason });
  return chunks;
};

/**
 * Convert a `generateText` result into a `ReadableStream` of `UIMessageChunk`s
 * ready to hand to `Run.pipe`. The generateText analogue of a `streamText`
 * result's `toUIMessageStream()`. See {@link toUIMessageChunks} for the exact
 * chunk sequence and the fidelity the one-shot path does not yet carry.
 * @param result - The `generateText` result to convert.
 * @returns A stream of the `UIMessageChunk`s representing the result, already
 *   closed after the final chunk.
 */
export const generateTextToUIMessageStream = <TOOLS extends AI.ToolSet>(
  result: OneShotResult<TOOLS>,
): ReadableStream<AI.UIMessageChunk> => {
  const chunks = toUIMessageChunks(result);
  return new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
};
