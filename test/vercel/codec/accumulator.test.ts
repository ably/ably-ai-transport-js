import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { DecoderOutput } from '../../../src/core/codec/types.js';
import { createAccumulator } from '../../../src/vercel/codec/accumulator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Output = DecoderOutput<AI.UIMessageChunk, AI.UIMessage>;

const DEFAULT_MSG_ID = 'msg-1';

const event = (chunk: AI.UIMessageChunk, messageId: string = DEFAULT_MSG_ID): Output => ({
  kind: 'event',
  event: chunk,
  messageId,
});
const message = (msg: AI.UIMessage): Output => ({ kind: 'message', message: msg });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vercel accumulator', () => {
  // -- basic text streaming -------------------------------------------------

  describe('text streaming', () => {
    it('accumulates text-start/delta/end into a message part', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-1' }),
        event({ type: 'start-step' }),
        event({ type: 'text-start', id: 'txt-1' }),
        event({ type: 'text-delta', id: 'txt-1', delta: 'hello' }),
        event({ type: 'text-delta', id: 'txt-1', delta: ' world' }),
        event({ type: 'text-end', id: 'txt-1' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.messages[0]?.id).toBe('msg-1');
      expect(acc.messages[0]?.role).toBe('assistant');
      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'hello world' }),
        ]),
      );
      expect(acc.hasActiveStream).toBe(false);
    });

    it('reports hasActiveStream during streaming', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'text-start', id: 'txt-1' }),
      ]);

      expect(acc.hasActiveStream).toBe(true);

      acc.processOutputs([event({ type: 'text-end', id: 'txt-1' })]);
      expect(acc.hasActiveStream).toBe(false);
    });
  });

  // -- reasoning streaming --------------------------------------------------

  describe('reasoning streaming', () => {
    it('accumulates reasoning parts', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'reasoning-start', id: 'r-1' }),
        event({ type: 'reasoning-delta', id: 'r-1', delta: 'thinking...' }),
        event({ type: 'reasoning-end', id: 'r-1' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', text: 'thinking...' }),
        ]),
      );
    });
  });

  // -- tool lifecycle -------------------------------------------------------

  describe('tool lifecycle', () => {
    it('accumulates tool-input streaming → input-available', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({
          type: 'tool-input-start',
          toolCallId: 'tc-1',
          toolName: 'search',
          title: 'Search',
        }),
        event({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q":' }),
        event({ type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '"test"}' }),
        event({
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'search',
          input: { q: 'test' },
        }),
      ]);

      const toolPart = acc.messages[0]?.parts.find(
        (p) => p.type === 'dynamic-tool' && p.toolCallId === 'tc-1',
      ) as AI.DynamicToolUIPart | undefined;

      expect(toolPart).toBeDefined();
      expect(toolPart?.state).toBe('input-available');
      expect(toolPart?.input).toEqual({ q: 'test' });
      expect(toolPart?.toolName).toBe('search');
      expect(toolPart?.title).toBe('Search');
    });

    it('transitions tool to output-available', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'calc' }),
        event({
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'calc',
          input: { x: 1 },
        }),
        event({
          type: 'tool-output-available',
          toolCallId: 'tc-1',
          output: { result: 42 },
        }),
      ]);

      const toolPart = acc.messages[0]?.parts.find(
        (p) => p.type === 'dynamic-tool',
      ) as AI.DynamicToolUIPart | undefined;
      expect(toolPart?.state).toBe('output-available');
      expect(toolPart?.input).toEqual({ x: 1 });
      expect(toolPart?.output).toEqual({ result: 42 });
    });

    it('transitions tool to output-error', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'calc' }),
        event({
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'calc',
          input: { x: 1 },
        }),
        event({
          type: 'tool-output-error',
          toolCallId: 'tc-1',
          errorText: 'timeout',
        }),
      ]);

      const toolPart = acc.messages[0]?.parts.find(
        (p) => p.type === 'dynamic-tool',
      ) as AI.DynamicToolUIPart | undefined;
      expect(toolPart?.state).toBe('output-error');
      expect(toolPart?.errorText).toBe('timeout');
    });

    it('transitions tool to output-denied', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'rm' }),
        event({
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'rm',
          input: { path: '/' },
        }),
        event({ type: 'tool-output-denied', toolCallId: 'tc-1' }),
      ]);

      const toolPart = acc.messages[0]?.parts.find(
        (p) => p.type === 'dynamic-tool',
      ) as AI.DynamicToolUIPart | undefined;
      expect(toolPart?.state).toBe('output-denied');
    });

    it('transitions tool to approval-requested', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'deploy' }),
        event({
          type: 'tool-input-available',
          toolCallId: 'tc-1',
          toolName: 'deploy',
          input: {},
        }),
        event({
          type: 'tool-approval-request',
          toolCallId: 'tc-1',
          approvalId: 'apr-1',
        }),
      ]);

      const toolPart = acc.messages[0]?.parts.find(
        (p) => p.type === 'dynamic-tool',
      ) as AI.DynamicToolUIPart | undefined;
      expect(toolPart?.state).toBe('approval-requested');
    });

    it('handles tool-input-error without prior start', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({
          type: 'tool-input-error',
          toolCallId: 'tc-1',
          toolName: 'search',
          errorText: 'parse error',
          input: { bad: true },
        }),
      ]);

      const toolPart = acc.messages[0]?.parts.find(
        (p) => p.type === 'dynamic-tool',
      ) as AI.DynamicToolUIPart | undefined;
      expect(toolPart?.state).toBe('output-error');
      expect(toolPart?.errorText).toBe('parse error');
    });
  });

  // -- content parts --------------------------------------------------------

  describe('content parts', () => {
    it('accumulates file parts', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'file', url: 'https://example.com/img.png' }),
        ]),
      );
    });

    it('accumulates source-url parts', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({
          type: 'source-url',
          sourceId: 'src-1',
          url: 'https://example.com',
          title: 'Example',
        }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'source-url', sourceId: 'src-1', title: 'Example' }),
        ]),
      );
    });

    it('accumulates source-document parts', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({
          type: 'source-document',
          sourceId: 'src-1',
          mediaType: 'application/pdf',
          title: 'Doc',
          filename: 'doc.pdf',
        }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'source-document', filename: 'doc.pdf' }),
        ]),
      );
    });
  });

  // -- data-* parts ---------------------------------------------------------

  describe('data-* parts', () => {
    it('accumulates data-* parts', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'data-custom' as AI.UIMessageChunk['type'], data: { foo: 'bar' }, id: 'dc-1' } as AI.UIMessageChunk),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'data-custom', data: { foo: 'bar' }, id: 'dc-1' }),
        ]),
      );
    });

    it('reconciles data-* parts with same type+id', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'data-status' as AI.UIMessageChunk['type'], data: { v: 1 }, id: 's-1' } as AI.UIMessageChunk),
        event({ type: 'data-status' as AI.UIMessageChunk['type'], data: { v: 2 }, id: 's-1' } as AI.UIMessageChunk),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      // Should have replaced in-place, not duplicated
      const dataParts = acc.messages[0]?.parts.filter((p) => p.type === 'data-status');
      expect(dataParts).toHaveLength(1);
      expect(dataParts?.[0]).toEqual(expect.objectContaining({ data: { v: 2 } }));
    });

    it('skips transient data-* parts', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'data-status' as AI.UIMessageChunk['type'], data: undefined, transient: true } as AI.UIMessageChunk),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      const dataParts = acc.messages[0]?.parts.filter((p) => p.type === 'data-status');
      expect(dataParts).toHaveLength(0);
    });
  });

  // -- message-level behavior -----------------------------------------------

  describe('message lifecycle', () => {
    it('sets messageMetadata from start chunk', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-1', messageMetadata: { key: 'val' } }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.metadata).toEqual({ key: 'val' });
    });

    it('sets messageMetadata from finish chunk', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-1' }),
        event({ type: 'finish', finishReason: 'stop', messageMetadata: { final: true } }),
      ]);

      expect(acc.messages[0]?.metadata).toEqual({ final: true });
    });

    it('sets messageMetadata from message-metadata chunk', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'message-metadata', messageMetadata: { key: 'val' } }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.metadata).toEqual({ key: 'val' });
    });

    it('uses DecoderOutput messageId as the UIMessage id', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages[0]?.id).toBe(DEFAULT_MSG_ID);
    });

    it('creates active message on start-step if no start received', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start-step' }),
        event({ type: 'text-start', id: 'txt-1' }),
        event({ type: 'text-delta', id: 'txt-1', delta: 'hi' }),
        event({ type: 'text-end', id: 'txt-1' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'step-start' }),
          expect.objectContaining({ type: 'text', text: 'hi' }),
        ]),
      );
    });

    it('separates completed from active messages', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-1' }),
        event({ type: 'text-start', id: 'txt-1' }),
      ]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(0);

      acc.processOutputs([
        event({ type: 'text-end', id: 'txt-1' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      expect(acc.completedMessages).toHaveLength(1);
    });

    it('closes active message on abort', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-1' }),
        event({ type: 'text-start', id: 'txt-1' }),
        event({ type: 'abort', reason: 'cancelled' }),
      ]);

      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.hasActiveStream).toBe(false);
    });
  });

  // -- complete message insertion -------------------------------------------

  describe('complete message insertion', () => {
    it('inserts complete UIMessage from decoder output', () => {
      const acc = createAccumulator();
      const userMsg: AI.UIMessage = {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      };

      acc.processOutputs([message(userMsg)]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.messages[0]).toBe(userMsg);
    });
  });

  // -- updateMessage --------------------------------------------------------

  describe('updateMessage', () => {
    it('replaces a message by ID', () => {
      const acc = createAccumulator();
      const userMsg: AI.UIMessage = {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      };
      acc.processOutputs([message(userMsg)]);

      const updated: AI.UIMessage = {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'updated' }],
      };
      acc.updateMessage(updated);

      expect(acc.messages[0]?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'updated' }),
      ]);
    });

    it('does nothing for unknown message ID', () => {
      const acc = createAccumulator();
      acc.updateMessage({ id: 'unknown', role: 'user', parts: [] });
      expect(acc.messages).toHaveLength(0);
    });
  });

  // -- finish-step resets text/reasoning tracking ---------------------------

  describe('finish-step reset', () => {
    it('allows text ID reuse across steps', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        event({ type: 'start' }),
        event({ type: 'start-step' }),
        event({ type: 'text-start', id: 'txt-1' }),
        event({ type: 'text-delta', id: 'txt-1', delta: 'step 1' }),
        event({ type: 'text-end', id: 'txt-1' }),
        event({ type: 'finish-step' }),
        // Reuse same text ID in next step
        event({ type: 'start-step' }),
        event({ type: 'text-start', id: 'txt-1' }),
        event({ type: 'text-delta', id: 'txt-1', delta: 'step 2' }),
        event({ type: 'text-end', id: 'txt-1' }),
        event({ type: 'finish', finishReason: 'stop' }),
      ]);

      const textParts = acc.messages[0]?.parts.filter((p) => p.type === 'text') ?? [];
      expect(textParts).toHaveLength(2);
      expect(textParts[0]).toEqual(expect.objectContaining({ text: 'step 1' }));
      expect(textParts[1]).toEqual(expect.objectContaining({ text: 'step 2' }));
    });
  });

  // -- concurrent messages (messageId routing) --------------------------------

  describe('concurrent messages', () => {
    it('routes interleaved events to separate messages by messageId', () => {
      const acc = createAccumulator();

      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-a' }, 'msg-a'),
        event({ type: 'start', messageId: 'msg-b' }, 'msg-b'),
        event({ type: 'start-step' }, 'msg-a'),
        event({ type: 'start-step' }, 'msg-b'),
        event({ type: 'text-start', id: 'txt-a' }, 'msg-a'),
        event({ type: 'text-start', id: 'txt-b' }, 'msg-b'),
        event({ type: 'text-delta', id: 'txt-a', delta: 'hello' }, 'msg-a'),
        event({ type: 'text-delta', id: 'txt-b', delta: 'world' }, 'msg-b'),
        event({ type: 'text-end', id: 'txt-a' }, 'msg-a'),
        event({ type: 'text-end', id: 'txt-b' }, 'msg-b'),
        event({ type: 'finish', finishReason: 'stop' }, 'msg-a'),
        event({ type: 'finish', finishReason: 'stop' }, 'msg-b'),
      ]);

      expect(acc.messages).toHaveLength(2);
      expect(acc.messages[0]?.id).toBe('msg-a');
      expect(acc.messages[1]?.id).toBe('msg-b');

      const textA = acc.messages[0]?.parts.find((p) => p.type === 'text');
      const textB = acc.messages[1]?.parts.find((p) => p.type === 'text');
      expect(textA).toEqual(expect.objectContaining({ text: 'hello' }));
      expect(textB).toEqual(expect.objectContaining({ text: 'world' }));

      expect(acc.completedMessages).toHaveLength(2);
      expect(acc.hasActiveStream).toBe(false);
    });

    it('tracks active streams independently per message', () => {
      const acc = createAccumulator();

      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-a' }, 'msg-a'),
        event({ type: 'start', messageId: 'msg-b' }, 'msg-b'),
        event({ type: 'text-start', id: 'txt-a' }, 'msg-a'),
        event({ type: 'text-start', id: 'txt-b' }, 'msg-b'),
      ]);

      expect(acc.hasActiveStream).toBe(true);
      expect(acc.completedMessages).toHaveLength(0);

      // Finish message A only
      acc.processOutputs([
        event({ type: 'text-end', id: 'txt-a' }, 'msg-a'),
        event({ type: 'finish', finishReason: 'stop' }, 'msg-a'),
      ]);

      expect(acc.hasActiveStream).toBe(true); // msg-b still streaming
      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.completedMessages[0]?.id).toBe('msg-a');

      // Finish message B
      acc.processOutputs([
        event({ type: 'text-end', id: 'txt-b' }, 'msg-b'),
        event({ type: 'finish', finishReason: 'stop' }, 'msg-b'),
      ]);

      expect(acc.hasActiveStream).toBe(false);
      expect(acc.completedMessages).toHaveLength(2);
    });

    it('handles abort on one message without affecting others', () => {
      const acc = createAccumulator();

      acc.processOutputs([
        event({ type: 'start', messageId: 'msg-a' }, 'msg-a'),
        event({ type: 'start', messageId: 'msg-b' }, 'msg-b'),
        event({ type: 'text-start', id: 'txt-a' }, 'msg-a'),
        event({ type: 'text-start', id: 'txt-b' }, 'msg-b'),
        event({ type: 'text-delta', id: 'txt-a', delta: 'partial' }, 'msg-a'),
        event({ type: 'abort' }, 'msg-a'),
      ]);

      // msg-a is aborted and completed; msg-b still active
      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.completedMessages[0]?.id).toBe('msg-a');
      expect(acc.hasActiveStream).toBe(true); // msg-b still streaming

      acc.processOutputs([
        event({ type: 'text-delta', id: 'txt-b', delta: 'still going' }, 'msg-b'),
        event({ type: 'text-end', id: 'txt-b' }, 'msg-b'),
        event({ type: 'finish', finishReason: 'stop' }, 'msg-b'),
      ]);

      expect(acc.messages).toHaveLength(2);
      expect(acc.completedMessages).toHaveLength(2);
      expect(acc.hasActiveStream).toBe(false);

      const textB = acc.messages[1]?.parts.find((p) => p.type === 'text');
      expect(textB).toEqual(expect.objectContaining({ text: 'still going' }));
    });
  });
});
