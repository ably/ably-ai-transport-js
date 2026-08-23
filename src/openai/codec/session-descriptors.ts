/**
 * The session layer's OpenAI input descriptors (see `session-events.ts`).
 */

import * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';

import { HEADER_ROLE } from '../../constants.js';
import type { InputBuilder, InputDescriptor } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { OpenAIMessage } from './events.js';
import { fApproved, fCallId, fReason } from './fields.js';
import type { OpenAISessionInput } from './session-events.js';

// Coerce arbitrary wire data to a string, defaulting to empty.
const asString = (data: unknown): string => (typeof data === 'string' ? data : '');

// Narrow JSON-parsed wire data to a record (trust boundary).
const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null;

/**
 * The session codec's OpenAI `ai-input` descriptor table — the wire mapping
 * for the session layer's five-variant input taxonomy. The public wire
 * codec's input table lives in `descriptors.ts`.
 *
 * The user message is a `batch`: a user message is a single input message item
 * whose content parts (`input_text`, and when we've done AIT-1120 `input_image` / `input_file`) are
 * fanned out into one `ai-input` event per part, all sharing `kind:
 * user-message` and the message's codec-message-id, each carrying its `partType`
 * and the message's `role`. The transport groups the parts into one node by
 * their shared codec-message-id; the reducer then merges them within that node
 * (see the reducer's user-message merge). A message with no encodable part
 * still emits one empty text part so it round-trips.
 * @param builder - The `{ event, batch }` builder curried on {@link OpenAISessionInput}.
 * @param builder.event - Declare a discrete input event.
 * @param builder.batch - Declare a multi-part (fan-out) input.
 * @returns The input descriptor table.
 */
export const sessionInputs = ({
  event,
  batch,
}: InputBuilder<OpenAISessionInput>): readonly InputDescriptor<OpenAISessionInput>[] => [
  // --- client-driven tool inputs: nested payload, codec-message-id-addressed --
  // Each addresses the assistant codec-message holding the function_call (via
  // the input's codecMessageId, stamped as the wire codec-message-id). call_id
  // rides the headers; the reducer folds the result into a function_call_output
  // item on that message and records status in its per-call_id tool-call state.

  event('tool-result', {
    fields: [fCallId],
    data: {
      encode: (p) => ({ output: p.output }),
      // CAST: the wire envelope carries the FunctionCallOutput output shape under `output` (trust boundary).
      decode: (d) => ({
        output: isRecord(d) ? (d.output as Responses.ResponseInputItem.FunctionCallOutput['output']) : '',
      }),
    },
  }),
  event('tool-result-error', {
    fields: [fCallId],
    data: {
      encode: (p) => ({ message: p.message }),
      decode: (d) => ({ message: isRecord(d) && typeof d.message === 'string' ? d.message : '' }),
    },
  }),
  event('tool-approval-response', { fields: [fCallId, fApproved, fReason] }),

  // Regenerate is a wire-only signal: it references an existing assistant
  // message by id, carries no payload, and folds to nothing. The agent reads
  // `target` / `parent` from the wire headers via the input-event lookup.
  event('regenerate', { wireOnly: true }),
  batch('user-message', {
    explode: (input) => {
      // Precondition: A user-message must have exactly one item, and this
      // item must have type "message". Note that this does not limit the
      // kinds of content that a user is able to send; they can send multiple
      // content parts within this single item.
      //
      // If we wished to support multiple items per user-message (which I
      // can't currently think of a reason we would want to) then we'd need
      // to make the exploded parts carry information on the wire about
      // which item index they belong to. However, then we'd end up in a
      // situation in which the projection would have to accommodate holes
      // in its `items` array whilst all of the items stream in; this is
      // structurally a similar problem to that described in AIT-1160 (see
      // the corresponding comment in the reducer's getMessages() for our
      // OpenAI-specific workaround for the generic problem that issue
      // describes).
      const { items } = input.message;
      const item = items.length === 1 ? items[0] : undefined;
      if (item?.type !== 'message') {
        throw new Ably.ErrorInfo(
          `unable to publish; a user message must be exactly one message item, got ${String(items.length)} item(s)`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      const parts: Responses.ResponseInputText[] = [];
      for (const part of item.content) {
        // Precondition: All parts must have type input_text, which is the
        // only part type we currently support.
        // TODO(AIT-1120): add `input_image` and `input_file` parts for richer prompts.
        if (part.type !== 'input_text') {
          throw new Ably.ErrorInfo(
            `unable to publish; unsupported input content part type '${part.type}'`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        parts.push(part);
      }
      // Guarantee ≥1 encodable part so an empty prompt still round-trips.
      const empty: Responses.ResponseInputText = { type: 'input_text', text: '' };
      return parts.length > 0 ? parts : [empty];
    },
    partTypeOf: (part) => part.type,
    parts: (p) => [p('input_text', { data: { encode: (part) => part.text, decode: (d) => ({ text: asString(d) }) } })],
    messageHeaders: (input) => ({ transportHeaders: { [HEADER_ROLE]: input.message.role } }),
    assemble: (part, { transportHeaders }) => {
      // Annotate the message so the items literal is contextually typed as
      // OpenAIItem (narrowing `type: 'message'`), independent of how the
      // assemble callback's return type is inferred for the input union.
      const message: OpenAIMessage = {
        // CAST: HEADER_ROLE is wire data; the role string is trusted as a message role.
        role: (transportHeaders[HEADER_ROLE] ?? 'user') as OpenAIMessage['role'],
        items: [{ type: 'message', role: 'user', content: [part] }],
      };
      return { message };
    },
  }),
];
