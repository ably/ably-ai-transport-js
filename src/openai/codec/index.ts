/**
 * OpenAI Responses codec — `ResponsesCodec`.
 *
 * The output direction is assembled by `defineCodec` from the declarative
 * output descriptor table and the decode lifecycle policy: it streams
 * assistant text, refusals, reasoning (summary and raw text) and function-call
 * arguments, handles server-side function calls (results and human-approval
 * requests), and repairs mid-stream joins via `decoderSynthesiseLifecycle`.
 * Hosted tools (web / file search, code interpreter, image gen, MCP, custom
 * tools) are not yet supported (AIT-1121).
 *
 * The input direction is a passthrough: `TInput` is `unknown`, and any
 * JSON-serialisable body a client publishes rides one discrete `ai-input`
 * message and decodes back verbatim. The application defines its own input
 * vocabulary (turn bodies, tool resolutions, approval decisions) and narrows
 * decoded inputs at its own merge boundary — the responses-transport demo
 * carries a worked example.
 *
 * ```ts
 * import { ResponsesCodec } from '@ably/ai-transport/openai';
 *
 * const decoder = ResponsesCodec.createDecoder();
 * ```
 */

import * as Ably from 'ably';

import { EVENT_AI_INPUT } from '../../constants.js';
import { createEncoderCore } from '../../core/codec/encoder.js';
import { defineCodec } from '../../core/codec/index.js';
import type {
  ChannelWriter,
  Decoder,
  Encoder,
  EncoderOptions,
  WireCodec,
  WriteOptions,
} from '../../core/codec/types.js';
import { ErrorCode } from '../../errors.js';
import { hasAiEnvelope } from '../../utils.js';
import { createResponsesDecodeLifecycle } from './decode-lifecycle.js';
import { outputs } from './descriptors.js';
import type { OpenAIOutput } from './events.js';

/**
 * The output half, assembled from the descriptor table. Its input table is
 * empty (`never`): the passthrough wrapper below owns the input direction and
 * intercepts `ai-input` wires before this decoder sees them.
 */
const outputCodec = defineCodec<never, OpenAIOutput>()({
  adapterTag: 'openai-responses',
  output: outputs,
  input: () => [],
  decoderSynthesiseLifecycle: createResponsesDecodeLifecycle,
});

/**
 * OpenAI Responses codec implementing `WireCodec<unknown, OpenAIOutput>`.
 * Outputs are OpenAI's own stream events plus the codec's two authored
 * events; inputs pass through as JSON (see the module header).
 */
export const ResponsesCodec: WireCodec<unknown, OpenAIOutput> = {
  adapterTag: 'openai-responses',

  createEncoder: (channel: ChannelWriter, options?: EncoderOptions): Encoder<unknown, OpenAIOutput> => {
    const inner = outputCodec.createEncoder(channel, options);
    // The input direction publishes through its own core so it shares the
    // header stamping (codec-message-id from opts.messageId, the caller's
    // extras) every codec input gets.
    const inputCore = createEncoderCore(channel, options ?? {});
    return {
      publishInput: async (input: unknown, opts?: WriteOptions): Promise<Ably.PublishResult> => {
        // CAST: TypeScript's lib types JSON.stringify as always returning a
        // string, but it returns undefined for undefined / function / symbol
        // inputs — the case the guard below rejects.
        const data = JSON.stringify(input) as string | undefined;
        if (data === undefined) {
          throw new Ably.ErrorInfo(
            'unable to publish input; the input must be JSON-serialisable',
            ErrorCode.InvalidArgument,
            400,
          );
        }
        return inputCore.publishDiscrete({ name: EVENT_AI_INPUT, data, codecHeaders: {} }, opts);
      },
      publishOutput: async (output: OpenAIOutput, opts?: WriteOptions): Promise<void> =>
        inner.publishOutput(output, opts),
      cancelStreams: async (): Promise<void> => inner.cancelStreams(),
      close: async (): Promise<void> => {
        await inner.close();
        await inputCore.close();
      },
    };
  },

  createDecoder: (): Decoder<unknown, OpenAIOutput> => {
    const inner = outputCodec.createDecoder();
    return {
      decode: (msg: Ably.InboundMessage): { inputs: unknown[]; outputs: OpenAIOutput[] } => {
        // The passthrough input path: our own `ai-input` wires carry the
        // published body as JSON. A same-named message without the SDK's
        // `extras.ai` envelope is foreign and decodes to nothing. Malformed
        // JSON throws at this trust boundary — the receive path drops the one
        // message and surfaces an error.
        if (msg.name === EVENT_AI_INPUT) {
          if (!hasAiEnvelope(msg)) return { inputs: [], outputs: [] };
          return { inputs: [JSON.parse(String(msg.data)) as unknown], outputs: [] };
        }
        return inner.decode(msg);
      },
    };
  },
};

export type { FunctionCallOutputEvent, ModelledOutputItem, OpenAIOutput, ToolApprovalRequestEvent } from './events.js';
export { isModelledOutputItem } from './events.js';
