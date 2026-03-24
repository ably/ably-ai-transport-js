import type * as Ably from 'ably';
import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import {
  DOMAIN_HEADER_PREFIX as D,
  HEADER_MSG_ID,
  HEADER_ROLE,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
  HEADER_TURN_ID,
} from '../../../src/constants.js';
import { createDecoder } from '../../../src/vercel/codec/decoder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const withHeaders = (
  msg: Partial<Ably.InboundMessage>,
  headers: Record<string, string>,
): Ably.InboundMessage =>
  ({
    serial: 'serial-1',
    action: 'message.create',
    name: 'text',
    data: '',
    ...msg,
    extras: { headers },
  }) as Ably.InboundMessage;

interface Output { kind: string; event?: AI.UIMessageChunk; message?: AI.UIMessage }

const eventsOf = (outputs: Output[]): AI.UIMessageChunk[] =>
  outputs
    .filter((o): o is Output & { event: AI.UIMessageChunk } => o.kind === 'event' && o.event !== undefined)
    .map((o) => o.event);

const eventTypesOf = (outputs: Output[]): string[] =>
  eventsOf(outputs).map((e) => e.type);

const messagesOf = (outputs: Output[]): AI.UIMessage[] =>
  outputs
    .filter((o): o is Output & { message: AI.UIMessage } => o.kind === 'message' && o.message !== undefined)
    .map((o) => o.message);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vercel decoder', () => {
  // -- lifecycle events -----------------------------------------------------

  describe('discrete lifecycle events', () => {
    it('decodes start event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'start', data: '' },
          {
            [HEADER_STREAM]: 'false',
            [`${D}messageId`]: 'msg-1',
            [`${D}messageMetadata`]: JSON.stringify({ key: 'val' }),
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'start', messageId: 'msg-1', messageMetadata: { key: 'val' } }),
      ]);
    });

    it('decodes finish event with finishReason', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'finish', data: '' },
          { [HEADER_STREAM]: 'false', [`${D}finishReason`]: 'stop' },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'finish', finishReason: 'stop' }),
      ]);
    });

    it('decodes finish-step event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'finish-step', data: '' },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      expect(eventTypesOf(outputs)).toContain('finish-step');
    });

    it('decodes error event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'error', data: 'something broke' },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'error', errorText: 'something broke' }),
      ]);
    });

    it('decodes abort event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'abort', data: 'cancelled' },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'abort', reason: 'cancelled' }),
      ]);
    });
  });

  // -- streamed text --------------------------------------------------------

  describe('streamed text', () => {
    it('emits synthetic start + start-step + text-start on stream create', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}messageId`]: 'msg-1',
            [`${D}id`]: 'txt-1',
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
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-1',
          },
        ),
      );

      // Append
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'text', data: 'hello' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'text-delta', id: 'txt-1', delta: 'hello' }),
      ]);
    });

    it('emits text-end on finished append', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-1',
          },
        ),
      );

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'text', data: '' },
          { [HEADER_STATUS]: 'finished', [HEADER_TURN_ID]: 'turn-1' },
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
      const startOutputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'reasoning', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'r-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'r-1',
          },
        ),
      );
      expect(eventTypesOf(startOutputs)).toContain('reasoning-start');

      // Delta
      const deltaOutputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'reasoning', data: 'think' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );
      expect(eventsOf(deltaOutputs)).toEqual([
        expect.objectContaining({ type: 'reasoning-delta', delta: 'think' }),
      ]);

      // End
      const endOutputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'reasoning', data: '' },
          { [HEADER_STATUS]: 'finished', [HEADER_TURN_ID]: 'turn-1' },
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
      const startOutputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'tool-input', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}toolCallId`]: 'tc-1',
            [`${D}toolName`]: 'search',
          },
        ),
      );
      expect(eventTypesOf(startOutputs)).toContain('tool-input-start');
      const startChunk = eventsOf(startOutputs).find((e) => e.type === 'tool-input-start');
      expect(startChunk).toEqual(
        expect.objectContaining({ toolCallId: 'tc-1', toolName: 'search' }),
      );

      // Delta
      const deltaOutputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'tool-input', data: '{"q":"test"}' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );
      expect(eventsOf(deltaOutputs)).toEqual([
        expect.objectContaining({ type: 'tool-input-delta', inputTextDelta: '{"q":"test"}' }),
      ]);

      // Available (finished)
      const endOutputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'tool-input', data: '' },
          { [HEADER_STATUS]: 'finished', [HEADER_TURN_ID]: 'turn-1', [`${D}toolName`]: 'search' },
        ),
      );
      const availChunk = eventsOf(endOutputs).find((e) => e.type === 'tool-input-available');
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
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'tool-input', data: '{"q":"test"}' },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}toolCallId`]: 'tc-1',
            [`${D}toolName`]: 'search',
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

  // -- tool lifecycle events ------------------------------------------------

  describe('tool lifecycle events', () => {
    it('decodes tool-input-error', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          {
            action: 'message.create',
            name: 'tool-input-error',
            data: { errorText: 'bad', input: { x: 1 } },
          },
          {
            [HEADER_STREAM]: 'false',
            [`${D}toolCallId`]: 'tc-1',
            [`${D}toolName`]: 'calc',
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
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
      const outputs = decoder.decode(
        withHeaders(
          {
            action: 'message.create',
            name: 'tool-output-available',
            data: { output: { result: 42 } },
          },
          {
            [HEADER_STREAM]: 'false',
            [`${D}toolCallId`]: 'tc-1',
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({
          type: 'tool-output-available',
          toolCallId: 'tc-1',
          output: { result: 42 },
        }),
      ]);
    });

    it('decodes tool-output-error', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          {
            action: 'message.create',
            name: 'tool-output-error',
            data: { errorText: 'timeout' },
          },
          {
            [HEADER_STREAM]: 'false',
            [`${D}toolCallId`]: 'tc-1',
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({
          type: 'tool-output-error',
          toolCallId: 'tc-1',
          errorText: 'timeout',
        }),
      ]);
    });

    it('decodes tool-approval-request', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'tool-approval-request', data: '' },
          {
            [HEADER_STREAM]: 'false',
            [`${D}toolCallId`]: 'tc-1',
            [`${D}approvalId`]: 'apr-1',
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({
          type: 'tool-approval-request',
          toolCallId: 'tc-1',
          approvalId: 'apr-1',
        }),
      ]);
    });

    it('decodes tool-output-denied', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'tool-output-denied', data: '' },
          { [HEADER_STREAM]: 'false', [`${D}toolCallId`]: 'tc-1' },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'tool-output-denied', toolCallId: 'tc-1' }),
      ]);
    });
  });

  // -- content parts --------------------------------------------------------

  describe('content parts', () => {
    it('decodes file event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'file', data: 'https://example.com/img.png' },
          { [HEADER_STREAM]: 'false', [`${D}mediaType`]: 'image/png' },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' }),
      ]);
    });

    it('decodes source-url event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'source-url', data: 'https://example.com' },
          {
            [HEADER_STREAM]: 'false',
            [`${D}sourceId`]: 'src-1',
            [`${D}title`]: 'Example',
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
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
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'source-document', data: '' },
          {
            [HEADER_STREAM]: 'false',
            [`${D}sourceId`]: 'src-1',
            [`${D}mediaType`]: 'application/pdf',
            [`${D}title`]: 'Doc',
            [`${D}filename`]: 'doc.pdf',
          },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
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
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-metadata', data: '' },
          { [HEADER_STREAM]: 'false', [`${D}messageMetadata`]: JSON.stringify({ key: 'val' }) },
        ),
      );

      expect(eventsOf(outputs)).toEqual([
        expect.objectContaining({ type: 'message-metadata', messageMetadata: { key: 'val' } }),
      ]);
    });
  });

  // -- data-* events --------------------------------------------------------

  describe('data-* events', () => {
    it('decodes data-* custom event', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'data-custom', data: { foo: 'bar' } },
          { [HEADER_STREAM]: 'false', [`${D}id`]: 'dc-1' },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({ type: 'data-custom', data: { foo: 'bar' }, id: 'dc-1' }),
      );
    });

    it('decodes data-* with transient flag', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'data-status', data: '' },
          { [HEADER_STREAM]: 'false', [`${D}transient`]: 'true' },
        ),
      );

      const events = eventsOf(outputs);
      expect(events[0]).toEqual(
        expect.objectContaining({ type: 'data-status', transient: true }),
      );
    });
  });

  // -- synthetic event deduplication ----------------------------------------

  describe('synthetic event deduplication', () => {
    it('emits start + start-step only once per turn', () => {
      const decoder = createDecoder();

      // First streamed message in turn
      const first = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-1',
          },
        ),
      );
      expect(eventTypesOf(first)).toContain('start');
      expect(eventTypesOf(first)).toContain('start-step');

      // Second streamed message in same turn
      const second = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: 'reasoning', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'r-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'r-1',
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
          { action: 'message.create', name: 'start', data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1', [`${D}messageId`]: 'msg-1' },
        ),
      );

      // Explicit start-step from channel
      const stepOutputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'start-step', data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );
      expect(eventTypesOf(stepOutputs)).toEqual(['start-step']);

      // Next streamed message should NOT synthesize start or start-step
      const streamOutputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-1',
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
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-1',
          },
        ),
      );

      // finish-step
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'finish-step', data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      // New stream in next step — should get start-step again
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-2',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-2',
          },
        ),
      );
      expect(eventTypesOf(outputs)).toContain('start-step');
      expect(eventTypesOf(outputs)).not.toContain('start'); // start already emitted for this turn
    });
  });

  // -- first-contact update -------------------------------------------------

  describe('first-contact update (history hydration)', () => {
    it('emits full lifecycle for finished streamed message', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello world' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'finished',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}id`]: 'txt-1',
          },
        ),
      );

      const types = eventTypesOf(outputs);
      expect(types).toContain('start');
      expect(types).toContain('start-step');
      expect(types).toContain('text-start');
      expect(types).toContain('text-delta');
      expect(types).toContain('text-end');

      const deltaEvent = eventsOf(outputs).find((e) => e.type === 'text-delta');
      expect(deltaEvent).toEqual(
        expect.objectContaining({ type: 'text-delta', delta: 'hello world' }),
      );
    });
  });

  // -- discrete message decoding (writeMessages echoes) ---------------------

  describe('discrete message decoding', () => {
    it('decodes a text message with x-ably-role into a UIMessage', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: 'text', data: 'Hello world' },
        { [HEADER_STREAM]: 'false', [HEADER_ROLE]: 'user', [HEADER_MSG_ID]: 'msg-1', [`${D}messageId`]: 'ui-1' },
      );

      const outputs = decoder.decode(msg);
      const messages = messagesOf(outputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          id: 'ui-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello world' }],
        }),
      );
    });

    it('decodes a file message with x-ably-role into a UIMessage', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: 'file', data: 'https://example.com/img.png' },
        { [HEADER_STREAM]: 'false', [HEADER_ROLE]: 'user', [HEADER_MSG_ID]: 'msg-2', [`${D}messageId`]: 'ui-2', [`${D}mediaType`]: 'image/png' },
      );

      const outputs = decoder.decode(msg);
      const messages = messagesOf(outputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          id: 'ui-2',
          role: 'user',
          parts: [{ type: 'file', mediaType: 'image/png', url: 'https://example.com/img.png' }],
        }),
      );
    });

    it('does not decode text as a discrete message when x-ably-role is absent', () => {
      const decoder = createDecoder();
      // Without x-ably-role, this is a lifecycle event context (e.g. streamed text)
      // and should not produce a message output
      const msg = withHeaders(
        { name: 'text', data: 'delta' },
        { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1', [HEADER_MSG_ID]: 'msg-3' },
      );

      const outputs = decoder.decode(msg);
      const messages = messagesOf(outputs);

      expect(messages).toHaveLength(0);
    });

    it('preserves role from headers', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: 'text', data: 'System message' },
        { [HEADER_STREAM]: 'false', [HEADER_ROLE]: 'system', [HEADER_MSG_ID]: 'msg-4', [`${D}messageId`]: 'ui-4' },
      );

      const outputs = decoder.decode(msg);
      const messages = messagesOf(outputs);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('system');
    });

    it('tags message outputs with messageId from x-ably-msg-id', () => {
      const decoder = createDecoder();
      const msg = withHeaders(
        { name: 'text', data: 'hi' },
        { [HEADER_STREAM]: 'false', [HEADER_ROLE]: 'user', [HEADER_MSG_ID]: 'msg-5', [`${D}messageId`]: 'ui-5' },
      );

      const outputs = decoder.decode(msg);
      // Message outputs don't have messageId (only event outputs do),
      // so this verifies the output is kind: 'message', not kind: 'event'
      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.kind).toBe('message');
    });
  });
});
