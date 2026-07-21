import type * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import {
  EVENT_AI_INPUT,
  EVENT_AI_OUTPUT,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_DISCRETE,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
} from '../../../src/constants.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';

// The codec is now assembled by defineCodec; createDecoder is the generic
// factory it produces (a plain closure, safe to destructure).
const createDecoder = UIMessageCodec.createDecoder;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The transport tier (`extras.ai.transport`) carries these generic
// transport headers; every other key is a codec header and lands under
// `extras.ai.codec`.
const TRANSPORT_HEADER_KEYS = new Set<string>([
  HEADER_STREAM,
  HEADER_STATUS,
  HEADER_STREAM_ID,
  HEADER_DISCRETE,
  HEADER_RUN_ID,
  HEADER_INVOCATION_ID,
  HEADER_EVENT_ID,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_RUN_CLIENT_ID,
  HEADER_INPUT_CLIENT_ID,
  HEADER_ROLE,
  HEADER_PARENT,
  HEADER_FORK_OF,
  HEADER_MSG_REGENERATE,
  HEADER_RUN_REASON,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
]);

const withHeaders = (msg: Partial<Ably.InboundMessage>, headers: Record<string, string>): Ably.InboundMessage => {
  const transport: Record<string, string> = {};
  const codec: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (TRANSPORT_HEADER_KEYS.has(key)) transport[key] = value;
    else codec[key] = value;
  }
  return {
    serial: 'serial-1',
    action: 'message.create',
    name: 'text',
    data: '',
    // `version` is required on InboundMessage; its `serial` is optional.
    version: {},
    ...msg,
    extras: { ai: { transport, codec } },
    // CAST: Tests construct a minimal Ably.InboundMessage stub; full shape isn't needed.
  } as Ably.InboundMessage;
};

const eventTypesOf = (outputs: AI.UIMessageChunk[]): string[] => outputs.map((e) => e.type);

const messagesOf = (inputs: ReturnType<ReturnType<typeof createDecoder>['decode']>['inputs']): AI.UIMessage[] =>
  inputs
    .filter((e): e is Extract<typeof e, { kind: 'user-message' }> => e.kind === 'user-message')
    .map((e) => e.message);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vercel decoder', () => {
  // -- lifecycle events -----------------------------------------------------

  describe('discrete lifecycle events', () => {
    it('decodes start event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'false',
            kind: 'start',
            messageId: 'msg-1',
            messageMetadata: JSON.stringify({ key: 'val' }),
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({ type: 'start', messageId: 'msg-1', messageMetadata: { key: 'val' } }),
      ]);
    });

    it('decodes finish event with finishReason', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STREAM]: 'false', kind: 'finish', finishReason: 'stop' },
        ),
      );

      expect(outputs).toEqual([expect.objectContaining({ type: 'finish', finishReason: 'stop' })]);
    });

    it('decodes finish-step event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STREAM]: 'false', kind: 'finish-step' },
        ),
      );

      expect(eventTypesOf(outputs)).toContain('finish-step');
    });

    it('decodes error event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'something broke' },
          { [HEADER_STREAM]: 'false', kind: 'error' },
        ),
      );

      expect(outputs).toEqual([expect.objectContaining({ type: 'error', errorText: 'something broke' })]);
    });

    it('decodes abort event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'cancelled' },
          { [HEADER_STREAM]: 'false', kind: 'abort' },
        ),
      );

      expect(outputs).toEqual([expect.objectContaining({ type: 'abort', reason: 'cancelled' })]);
    });
  });

  // -- streamed text --------------------------------------------------------

  describe('streamed text', () => {
    it('emits synthetic start + start-step + text-start on stream create', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            messageId: 'msg-1',
            id: 'txt-1',
          },
        ),
      );

      const types = eventTypesOf(outputs);
      expect(types).toEqual(['start', 'start-step', 'text-start']);
    });

    it('emits text-delta on append', () => {
      const decoder = createDecoder();
      // Create
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      // Append
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: EVENT_AI_OUTPUT, data: 'hello' },
          { [HEADER_RUN_ID]: 'run-1' },
        ),
      );

      expect(outputs).toEqual([expect.objectContaining({ type: 'text-delta', id: 'txt-1', delta: 'hello' })]);
    });

    it('emits text-end on complete append', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STATUS]: 'complete', [HEADER_RUN_ID]: 'run-1' },
        ),
      );

      expect(eventTypesOf(outputs)).toContain('text-end');
    });
  });

  // -- streamed reasoning ---------------------------------------------------

  describe('streamed reasoning', () => {
    it('emits reasoning-start/delta/end lifecycle', () => {
      const decoder = createDecoder();

      // Create
      const { outputs: startOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'r-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'reasoning',
            id: 'r-1',
          },
        ),
      );
      expect(eventTypesOf(startOutputs)).toContain('reasoning-start');

      // Delta
      const { outputs: deltaOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: EVENT_AI_OUTPUT, data: 'think' },
          { [HEADER_RUN_ID]: 'run-1' },
        ),
      );
      expect(deltaOutputs).toEqual([expect.objectContaining({ type: 'reasoning-delta', id: 'r-1', delta: 'think' })]);

      // End
      const { outputs: endOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STATUS]: 'complete', [HEADER_RUN_ID]: 'run-1' },
        ),
      );
      expect(eventTypesOf(endOutputs)).toContain('reasoning-end');
    });
  });

  // -- streamed tool-input --------------------------------------------------

  describe('streamed tool-input', () => {
    it('emits tool-input-start/delta/available lifecycle', () => {
      const decoder = createDecoder();

      // Create
      const { outputs: startOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'tool-input',
            toolCallId: 'tc-1',
            toolName: 'search',
          },
        ),
      );
      expect(eventTypesOf(startOutputs)).toContain('tool-input-start');
      const startChunk = startOutputs.find((e) => e.type === 'tool-input-start');
      expect(startChunk).toEqual(expect.objectContaining({ toolCallId: 'tc-1', toolName: 'search' }));

      // Delta
      const { outputs: deltaOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: EVENT_AI_OUTPUT, data: '{"q":"test"}' },
          { [HEADER_RUN_ID]: 'run-1' },
        ),
      );
      expect(deltaOutputs).toEqual([
        expect.objectContaining({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q":"test"}' }),
      ]);

      // Available (complete)
      const { outputs: endOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STATUS]: 'complete', [HEADER_RUN_ID]: 'run-1', toolName: 'search' },
        ),
      );
      const availChunk = endOutputs.find((e) => e.type === 'tool-input-available');
      expect(availChunk).toBeDefined();
      expect(availChunk).toEqual(
        expect.objectContaining({
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'search',
          input: { q: 'test' },
        }),
      );
    });
  });

  // -- discrete tool-input --------------------------------------------------

  describe('discrete (non-streaming) tool-input', () => {
    it('emits tool-input-start + tool-input-available', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '{"q":"test"}' },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'tool-input',
            toolCallId: 'tc-1',
            toolName: 'search',
          },
        ),
      );

      const types = eventTypesOf(outputs);
      expect(types).toContain('start');
      expect(types).toContain('start-step');
      expect(types).toContain('tool-input-start');
      expect(types).toContain('tool-input-available');
    });
  });

  // -- tool-input dynamic flag ----------------------------------------------
  //
  // The `dynamic` header distinguishes a dynamic tool from a statically-declared
  // one; it must reach the decoded `tool-input-start` chunk so the reducer can
  // reconstruct the right part representation. Absent → static (no `dynamic` on
  // the chunk); present `true` → dynamic.

  describe('tool-input dynamic flag', () => {
    it('carries dynamic: true onto the streamed tool-input-start chunk', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'tool-input',
            toolCallId: 'tc-1',
            toolName: 'search',
            dynamic: 'true',
          },
        ),
      );
      const startChunk = outputs.find((e) => e.type === 'tool-input-start');
      expect(startChunk).toEqual(expect.objectContaining({ type: 'tool-input-start', dynamic: true }));
    });

    it('carries dynamic: true onto the discrete tool-input-start chunk', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '{"q":"x"}' },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'tool-input',
            toolCallId: 'tc-1',
            toolName: 'search',
            dynamic: 'true',
          },
        ),
      );
      const startChunk = outputs.find((e) => e.type === 'tool-input-start');
      expect(startChunk).toEqual(expect.objectContaining({ type: 'tool-input-start', dynamic: true }));
    });

    it('leaves dynamic off the tool-input-start chunk for a static tool (no dynamic header)', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '{"q":"x"}' },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'tool-input',
            toolCallId: 'tc-1',
            toolName: 'search',
          },
        ),
      );
      const startChunk = outputs.find((e) => e.type === 'tool-input-start');
      expect(startChunk).toBeDefined();
      expect(startChunk && 'dynamic' in startChunk).toBe(false);
    });
  });

  // -- tool lifecycle events ------------------------------------------------

  describe('tool lifecycle events', () => {
    it('decodes tool-input-error', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          {
            action: 'message.create',
            name: EVENT_AI_OUTPUT,
            data: { errorText: 'bad', input: { x: 1 } },
          },
          {
            [HEADER_STREAM]: 'false',
            kind: 'tool-input-error',
            toolCallId: 'tc-1',
            toolName: 'calc',
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({
          type: 'tool-input-error',
          toolCallId: 'tc-1',
          toolName: 'calc',
          errorText: 'bad',
          input: { x: 1 },
        }),
      ]);
    });

    it('decodes tool-output-available', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          {
            action: 'message.create',
            name: EVENT_AI_OUTPUT,
            data: { output: { result: 42 } },
          },
          {
            [HEADER_STREAM]: 'false',
            kind: 'tool-output-available',
            toolCallId: 'tc-1',
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({
          type: 'tool-output-available',
          toolCallId: 'tc-1',
          output: { result: 42 },
        }),
      ]);
    });

    it('decodes tool-output-error', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          {
            action: 'message.create',
            name: EVENT_AI_OUTPUT,
            data: { errorText: 'timeout' },
          },
          {
            [HEADER_STREAM]: 'false',
            kind: 'tool-output-error',
            toolCallId: 'tc-1',
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({
          type: 'tool-output-error',
          toolCallId: 'tc-1',
          errorText: 'timeout',
        }),
      ]);
    });

    it('decodes tool-approval-request', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'false',
            kind: 'tool-approval-request',
            toolCallId: 'tc-1',
            approvalId: 'apr-1',
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({
          type: 'tool-approval-request',
          toolCallId: 'tc-1',
          approvalId: 'apr-1',
        }),
      ]);
    });

    it('decodes tool-output-denied', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STREAM]: 'false', kind: 'tool-output-denied', toolCallId: 'tc-1' },
        ),
      );

      expect(outputs).toEqual([expect.objectContaining({ type: 'tool-output-denied', toolCallId: 'tc-1' })]);
    });
  });

  // -- malformed tool wire data (trust-boundary guards) ---------------------

  describe('malformed tool wire data falls back to defaults', () => {
    it('tool-input-error: non-object data is rejected — empty errorText, no input', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'oops' },
          { [HEADER_STREAM]: 'false', kind: 'tool-input-error', toolCallId: 'tc-1', toolName: 'calc' },
        ),
      );
      const [chunk] = outputs;
      expect(chunk).toMatchObject({ type: 'tool-input-error', toolCallId: 'tc-1', errorText: '' });
      expect(chunk).not.toHaveProperty('input');
    });

    it('tool-input-error: non-string errorText is rejected — falls back to empty', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: { errorText: 42, input: { x: 1 } } },
          { [HEADER_STREAM]: 'false', kind: 'tool-input-error', toolCallId: 'tc-1', toolName: 'calc' },
        ),
      );
      expect(outputs).toEqual([expect.objectContaining({ type: 'tool-input-error', errorText: '' })]);
    });

    it('tool-output-available: non-object data is rejected — no output', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'oops' },
          { [HEADER_STREAM]: 'false', kind: 'tool-output-available', toolCallId: 'tc-1' },
        ),
      );
      const [chunk] = outputs;
      expect(chunk).toMatchObject({ type: 'tool-output-available', toolCallId: 'tc-1' });
      expect(chunk).not.toHaveProperty('output');
    });

    it('tool-output-error: non-string errorText is rejected — falls back to empty', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: { errorText: { nested: true } } },
          { [HEADER_STREAM]: 'false', kind: 'tool-output-error', toolCallId: 'tc-1' },
        ),
      );
      expect(outputs).toEqual([
        expect.objectContaining({ type: 'tool-output-error', toolCallId: 'tc-1', errorText: '' }),
      ]);
    });
  });

  // -- content parts --------------------------------------------------------

  describe('content parts', () => {
    it('decodes file event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'https://example.com/img.png' },
          { [HEADER_STREAM]: 'false', kind: 'file', mediaType: 'image/png' },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({ type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' }),
      ]);
    });

    it('decodes source-url event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'https://example.com' },
          {
            [HEADER_STREAM]: 'false',
            kind: 'source-url',
            sourceId: 'src-1',
            title: 'Example',
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({
          type: 'source-url',
          sourceId: 'src-1',
          url: 'https://example.com',
          title: 'Example',
        }),
      ]);
    });

    it('decodes source-document event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'false',
            kind: 'source-document',
            sourceId: 'src-1',
            mediaType: 'application/pdf',
            title: 'Doc',
            filename: 'doc.pdf',
          },
        ),
      );

      expect(outputs).toEqual([
        expect.objectContaining({
          type: 'source-document',
          sourceId: 'src-1',
          mediaType: 'application/pdf',
          title: 'Doc',
          filename: 'doc.pdf',
        }),
      ]);
    });

    it('decodes message-metadata event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'false',
            kind: 'message-metadata',
            messageMetadata: JSON.stringify({ key: 'val' }),
          },
        ),
      );

      expect(outputs).toEqual([expect.objectContaining({ type: 'message-metadata', messageMetadata: { key: 'val' } })]);
    });
  });

  // -- data-* events --------------------------------------------------------

  describe('data-* events', () => {
    it('decodes data-* custom event', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: { foo: 'bar' } },
          { [HEADER_STREAM]: 'false', kind: 'data-custom', id: 'dc-1' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual(expect.objectContaining({ type: 'data-custom', data: { foo: 'bar' }, id: 'dc-1' }));
    });

    it('decodes data-* with transient flag', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STREAM]: 'false', kind: 'data-status', transient: 'true' },
        ),
      );

      expect(outputs[0]).toEqual(expect.objectContaining({ type: 'data-status', transient: true }));
    });
  });

  // -- synthetic event deduplication ----------------------------------------

  describe('synthetic event deduplication', () => {
    it('emits start + start-step only once per run', () => {
      const decoder = createDecoder();

      // First streamed message in run
      const { outputs: first } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );
      expect(eventTypesOf(first)).toContain('start');
      expect(eventTypesOf(first)).toContain('start-step');

      // Second streamed message in same run
      const { outputs: second } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'r-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'reasoning',
            id: 'r-1',
          },
        ),
      );
      // Should NOT emit another start or start-step
      expect(eventTypesOf(second)).not.toContain('start');
      expect(eventTypesOf(second)).not.toContain('start-step');
    });

    it('decodes explicit start-step from channel and suppresses synthetic', () => {
      const decoder = createDecoder();

      // Explicit start from channel
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'start',
            messageId: 'msg-1',
          },
        ),
      );

      // Explicit start-step from channel
      const { outputs: stepOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_RUN_ID]: 'run-1', kind: 'start-step' },
        ),
      );
      expect(eventTypesOf(stepOutputs)).toEqual(['start-step']);

      // Next streamed message should NOT synthesize start or start-step
      const { outputs: streamOutputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );
      expect(eventTypesOf(streamOutputs)).toEqual(['text-start']);
    });

    it('resets start-step after finish-step', () => {
      const decoder = createDecoder();

      // First stream in step
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      // finish-step
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_RUN_ID]: 'run-1', kind: 'finish-step' },
        ),
      );

      // New stream in next step — should get start-step again
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-2',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-2',
          },
        ),
      );
      expect(eventTypesOf(outputs)).toContain('start-step');
      expect(eventTypesOf(outputs)).not.toContain('start'); // start already emitted for this run
    });

    it('clears lifecycle scope after finish', () => {
      const decoder = createDecoder();

      // Stream content — synthesizes start + start-step
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      // finish — clears scope
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'finish',
            finishReason: 'stop',
          },
        ),
      );

      // New content on same run — should re-synthesize start + start-step
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-2',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-2',
          },
        ),
      );
      expect(eventTypesOf(outputs)).toContain('start');
      expect(eventTypesOf(outputs)).toContain('start-step');
    });

    it('clears lifecycle scope after abort', () => {
      const decoder = createDecoder();

      // Stream content — synthesizes start + start-step
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      // abort — clears scope
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'cancelled' },
          { [HEADER_STREAM]: 'false', [HEADER_RUN_ID]: 'run-1', kind: 'abort' },
        ),
      );

      // New content on same run — should re-synthesize start + start-step
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-2',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-2',
          },
        ),
      );
      expect(eventTypesOf(outputs)).toContain('start');
      expect(eventTypesOf(outputs)).toContain('start-step');
    });

    it('clears lifecycle scope after error', () => {
      const decoder = createDecoder();

      // Stream content — synthesizes start + start-step
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      // error — clears scope
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: EVENT_AI_OUTPUT, data: 'something broke' },
          { [HEADER_STREAM]: 'false', [HEADER_RUN_ID]: 'run-1', kind: 'error' },
        ),
      );

      // New content on same run — should re-synthesize start + start-step
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: EVENT_AI_OUTPUT, data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-2',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-2',
          },
        ),
      );
      expect(eventTypesOf(outputs)).toContain('start');
      expect(eventTypesOf(outputs)).toContain('start-step');
    });
  });

  // -- first-contact update -------------------------------------------------

  describe('first-contact update (history hydration)', () => {
    it('emits full lifecycle for complete streamed message', () => {
      const decoder = createDecoder();
      const { outputs } = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: EVENT_AI_OUTPUT, data: 'hello world' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'complete',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_RUN_ID]: 'run-1',
            kind: 'text',
            id: 'txt-1',
          },
        ),
      );

      const types = eventTypesOf(outputs);
      expect(types).toContain('start');
      expect(types).toContain('start-step');
      expect(types).toContain('text-start');
      expect(types).toContain('text-delta');
      expect(types).toContain('text-end');

      const deltaEvent = outputs.find((e) => e.type === 'text-delta');
      expect(deltaEvent).toEqual(expect.objectContaining({ type: 'text-delta', delta: 'hello world' }));
    });
  });

  // -- discrete message decoding (writeMessages relays) ---------------------

  describe('discrete message decoding', () => {
    it('decodes a text user-message part into a UIMessage', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: 'Hello world' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_DISCRETE]: 'true',
          [HEADER_ROLE]: 'user',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-1',
          kind: 'user-message',
          partType: 'text',
          messageId: 'ui-1',
        },
      );

      const { inputs } = decoder.decode(msg);
      const messages = messagesOf(inputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          id: 'ui-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello world' }],
        }),
      );
    });

    it('decodes a file user-message part into a UIMessage', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: 'https://example.com/img.png' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_DISCRETE]: 'true',
          [HEADER_ROLE]: 'user',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-2',
          kind: 'user-message',
          partType: 'file',
          messageId: 'ui-2',
          mediaType: 'image/png',
        },
      );

      const { inputs } = decoder.decode(msg);
      const messages = messagesOf(inputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          id: 'ui-2',
          role: 'user',
          parts: [{ type: 'file', mediaType: 'image/png', url: 'https://example.com/img.png' }],
        }),
      );
    });

    it('decodes data-* user-message part as a discrete message', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: { agentLabel: 'Returns', tasks: [] } },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_DISCRETE]: 'true',
          [HEADER_ROLE]: 'user',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-d1',
          kind: 'user-message',
          partType: 'data-agent-progress',
          messageId: 'ui-d1',
          id: 'dp-1',
        },
      );

      const { inputs } = decoder.decode(msg);
      const messages = messagesOf(inputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          id: 'ui-d1',
          role: 'user',
          parts: [{ type: 'data-agent-progress', id: 'dp-1', data: { agentLabel: 'Returns', tasks: [] } }],
        }),
      );
    });

    it('decodes agent-published data-* events under ai-output as projection events, not user-message parts', () => {
      const decoder = createDecoder();
      // Agent-published data-* events ride `ai-output` with the codec `kind`
      // header carrying the codec event type. They carry no HEADER_DISCRETE and
      // produce an output event so the accumulator can merge them into
      // the streamed assistant response message.
      const msg = withHeaders(
        { name: EVENT_AI_OUTPUT, data: { agentLabel: 'Returns', tasks: [] } },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_ROLE]: 'assistant',
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-d2',
          kind: 'data-agent-progress',
        },
      );

      const { inputs, outputs } = decoder.decode(msg);
      const messages = messagesOf(inputs);

      expect(messages).toHaveLength(0);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual(
        expect.objectContaining({ type: 'data-agent-progress', data: { agentLabel: 'Returns', tasks: [] } }),
      );
    });

    it('preserves role from headers', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: 'System message' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_DISCRETE]: 'true',
          [HEADER_ROLE]: 'system',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-4',
          kind: 'user-message',
          partType: 'text',
          messageId: 'ui-4',
        },
      );

      const { inputs } = decoder.decode(msg);
      const messages = messagesOf(inputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('system');
    });

    it('decodes a discrete user-message part as a UserMessage', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: 'hi' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_DISCRETE]: 'true',
          [HEADER_ROLE]: 'user',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-5',
          kind: 'user-message',
          partType: 'text',
          messageId: 'ui-5',
        },
      );

      const { inputs, outputs } = decoder.decode(msg);
      expect(outputs).toHaveLength(0);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.kind).toBe('user-message');
    });

    it('decodes ai-input tool-approval-response into a ToolApprovalResponse input', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: '' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_CODEC_MESSAGE_ID]: 'continuation-codec-message-id',
          kind: 'tool-approval-response',
          toolCallId: 'tc-1',
          approved: 'true',
          reason: 'ok',
        },
      );

      const { inputs, outputs } = decoder.decode(msg);
      expect(outputs).toHaveLength(0);
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-approval-response');
      if (input?.kind !== 'tool-approval-response') return;
      expect(input.payload.toolCallId).toBe('tc-1');
      expect(input.payload.approved).toBe(true);
      expect(input.payload.reason).toBe('ok');
      expect(input.codecMessageId).toBe('continuation-codec-message-id');
    });

    it('decodes ai-input tool-result wire into a ToolResult input', () => {
      const decoder = createDecoder();
      // Client-side tool-result rides the `ai-input` wire with
      // kind: 'tool-result'.
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: { output: { latitude: 51.5, longitude: -0.1 } } },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_CODEC_MESSAGE_ID]: 'continuation-codec-message-id',
          kind: 'tool-result',
          toolCallId: 'tc-1',
        },
      );

      const { inputs, outputs } = decoder.decode(msg);
      expect(outputs).toHaveLength(0);
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-result');
      if (input?.kind !== 'tool-result') return;
      expect(input.payload.toolCallId).toBe('tc-1');
      expect(input.payload.output).toEqual({ latitude: 51.5, longitude: -0.1 });
      expect(input.codecMessageId).toBe('continuation-codec-message-id');
    });

    it('decodes ai-input tool-result-error wire into a ToolResultError input', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: { message: 'geolocation denied' } },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_CODEC_MESSAGE_ID]: 'continuation-codec-message-id',
          kind: 'tool-result-error',
          toolCallId: 'tc-1',
        },
      );

      const { inputs, outputs } = decoder.decode(msg);
      expect(outputs).toHaveLength(0);
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-result-error');
      if (input?.kind !== 'tool-result-error') return;
      expect(input.payload.toolCallId).toBe('tc-1');
      expect(input.payload.message).toBe('geolocation denied');
      expect(input.codecMessageId).toBe('continuation-codec-message-id');
    });

    it('rejects non-object tool-result wire data — output is undefined', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: 'oops' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_CODEC_MESSAGE_ID]: 'continuation-codec-message-id',
          kind: 'tool-result',
          toolCallId: 'tc-1',
        },
      );

      const { inputs } = decoder.decode(msg);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-result');
      if (input?.kind !== 'tool-result') return;
      expect(input.payload.toolCallId).toBe('tc-1');
      expect(input.payload.output).toBeUndefined();
    });

    it('rejects non-string tool-result-error message — falls back to empty', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: { message: 99 } },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_CODEC_MESSAGE_ID]: 'continuation-codec-message-id',
          kind: 'tool-result-error',
          toolCallId: 'tc-1',
        },
      );

      const { inputs } = decoder.decode(msg);
      const input = inputs[0];
      expect(input?.kind).toBe('tool-result-error');
      if (input?.kind !== 'tool-result-error') return;
      expect(input.payload.toolCallId).toBe('tc-1');
      expect(input.payload.message).toBe('');
    });

    it('dispatches a user-message part on kind alone — no HEADER_DISCRETE marker required', () => {
      const decoder = createDecoder();
      // The discrete marker is deliberately omitted. Input dispatch is now a
      // single `kind` switch, so a `kind: 'user-message'` part reconstructs
      // without consulting HEADER_DISCRETE.
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: 'no marker' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_ROLE]: 'user',
          [HEADER_CODEC_MESSAGE_ID]: 'msg-nd',
          kind: 'user-message',
          partType: 'text',
          messageId: 'ui-nd',
        },
      );

      expect(HEADER_DISCRETE in (msg.extras as { ai: { transport: Record<string, string> } }).ai.transport).toBe(false);

      const { inputs } = decoder.decode(msg);
      const messages = messagesOf(inputs);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({ id: 'ui-nd', role: 'user', parts: [{ type: 'text', text: 'no marker' }] }),
      );
    });

    it('decodes ai-input regenerate wires into zero events (routing lives on transport headers)', () => {
      const decoder = createDecoder();
      // The regenerate wire carries `parent` and `msg-regenerate`
      // on transport headers so the agent's input-event lookup can resolve
      // run-routing metadata from the matched event's headers. The decoder
      // itself has no domain events to emit — regenerate wires are wire-only.
      const msg = withHeaders(
        { name: EVENT_AI_INPUT, data: '' },
        {
          [HEADER_STREAM]: 'false',
          [HEADER_CODEC_MESSAGE_ID]: 'regen-codec-message-id',
          [HEADER_ROLE]: 'user',
          kind: 'regenerate',
          parent: 'user-U1',
          'msg-regenerate': 'asst-A1',
          'event-id': 'prompt-1',
        },
      );

      const { inputs, outputs } = decoder.decode(msg);
      expect(inputs).toEqual([]);
      expect(outputs).toEqual([]);
    });
  });
});
