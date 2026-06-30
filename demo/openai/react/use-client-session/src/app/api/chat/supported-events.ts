/**
 * Stream filter for the OpenAI Responses codec.
 *
 * The codec encodes only a subset of OpenAI's `ResponseStreamEvent` union and
 * deliberately throws on any output event it doesn't recognise (a real safety
 * net — see the codec's descriptor table). A real `/responses` stream can carry
 * events outside that subset (reasoning, refusals, annotations, function-call
 * arguments, …), so the agent must drop them before `run.pipe`, or the codec's
 * encoder would throw mid-stream.
 *
 * TODO(AIT-742): this filter shrinks as the codec grows — reasoning, refusals,
 * annotations, and function calls each become supported in later increments,
 * at which point their event types move out of the dropped set.
 */

import type { Responses } from 'openai/resources/responses/responses';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

/**
 * The `ResponseStreamEvent` types the codec's descriptor table declares (and so
 * can encode without throwing): the streamed assistant-text family, the
 * response lifecycle, the item / content-part envelopes, and the stream-level
 * `error`. Kept in sync with `src/openai/codec/descriptors.ts`.
 */
export const SUPPORTED_EVENT_TYPES: ReadonlySet<ResponseStreamEvent['type']> = new Set<ResponseStreamEvent['type']>([
  // Streamed assistant text.
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  // Item envelopes.
  'response.output_item.added',
  'response.output_item.done',
  // Response lifecycle.
  'response.created',
  'response.in_progress',
  'response.queued',
  'response.completed',
  'response.incomplete',
  'response.failed',
  // Stream-level error.
  'error',
]);

/**
 * A `TransformStream` that forwards only codec-supported `ResponseStreamEvent`s
 * and drops the rest, logging each dropped type once so the gap is visible
 * without flooding the console.
 * @returns A transform to insert before `run.pipe`.
 */
export function filterSupportedEvents(): TransformStream<ResponseStreamEvent, ResponseStreamEvent> {
  const loggedDroppedTypes = new Set<string>();
  return new TransformStream<ResponseStreamEvent, ResponseStreamEvent>({
    transform(event, controller) {
      if (SUPPORTED_EVENT_TYPES.has(event.type)) {
        controller.enqueue(event);
        return;
      }
      if (!loggedDroppedTypes.has(event.type)) {
        loggedDroppedTypes.add(event.type);
        console.warn(`[openai-demo] dropping unsupported Responses event type: ${event.type}`);
      }
    },
  });
}
