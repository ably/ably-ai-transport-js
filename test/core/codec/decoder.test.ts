import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_MSG_ID, HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../../src/constants.js';
import type { DecoderCoreHooks } from '../../../src/core/codec/decoder.js';
import { createDecoderCore } from '../../../src/core/codec/decoder.js';

// ---------------------------------------------------------------------------
// Test event/message types
// ---------------------------------------------------------------------------

type TestEvent =
  | { type: 'start'; streamId: string }
  | { type: 'delta'; streamId: string; delta: string }
  | { type: 'end'; streamId: string }
  | { type: 'discrete'; name: string; data: string };

interface TestMessage { id: string; text: string }

// ---------------------------------------------------------------------------
// Mock hooks factory
// ---------------------------------------------------------------------------

const createMockHooks = (): DecoderCoreHooks<TestEvent, TestMessage> => ({
  buildStartEvents: (tracker) => [
    { kind: 'event', event: { type: 'start', streamId: tracker.streamId } },
  ],
  buildDeltaEvents: (tracker, delta) => [
    { kind: 'event', event: { type: 'delta', streamId: tracker.streamId, delta } },
  ],
  buildEndEvents: (tracker) => [
    { kind: 'event', event: { type: 'end', streamId: tracker.streamId } },
  ],
  decodeDiscrete: (input) => [
    {
      kind: 'event',
      event: { type: 'discrete', name: input.name, data: typeof input.data === 'string' ? input.data : '' },
    },
  ],
});

// ---------------------------------------------------------------------------
// Ably InboundMessage helpers
// ---------------------------------------------------------------------------

const withHeaders = (msg: Partial<Ably.InboundMessage>, headers: Record<string, string>): Ably.InboundMessage =>
  ({
    serial: 'serial-1',
    action: 'message.create',
    name: 'text',
    data: '',
    ...msg,
    extras: { headers },
  }) as Ably.InboundMessage;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDecoderCore', () => {
  let hooks: DecoderCoreHooks<TestEvent, TestMessage>;

  beforeEach(() => {
    hooks = createMockHooks();
  });

  // -- message.create (streamed) -------------------------------------------

  describe('message.create (streamed)', () => {
    it('emits start events for a streamable message', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'start', streamId: 'id-1' } }]);
    });

    it('returns empty for missing serial', () => {
      const decoder = createDecoderCore(hooks);
      expect(
        decoder.decode(
          withHeaders(
            { action: 'message.create', serial: undefined, name: 'text' },
            { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming' },
          ),
        ),
      ).toEqual([]);
    });
  });

  // -- message.create (discrete) -------------------------------------------

  describe('message.create (discrete)', () => {
    it('delegates to decodeDiscrete for non-streamed messages', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders({ action: 'message.create', name: 'user-message', data: 'hello' }, { [HEADER_STREAM]: 'false' }),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'discrete', name: 'user-message', data: 'hello' } }]);
    });

    it('handles non-string data by defaulting to empty string', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders({ action: 'message.create', name: 'user-message', data: 42 }, { [HEADER_STREAM]: 'false' }),
      );

      expect((outputs[0] as { kind: 'event'; event: TestEvent }).event).toEqual({
        type: 'discrete',
        name: 'user-message',
        data: '',
      });
    });
  });

  // -- message.append ------------------------------------------------------

  describe('message.append', () => {
    it('emits delta events for known streams', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));
      expect(outputs).toEqual([{ kind: 'event', event: { type: 'delta', streamId: 'id-1', delta: 'hello' } }]);
    });

    it('emits end events when status is finished', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'finished' }),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'end', streamId: 'id-1' } }]);
    });

    it('does not emit end after abort (closed flag prevents duplicate)', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'aborted' }));

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'finished' }),
      );

      expect(outputs).toHaveLength(0);
    });

    it('emits delta AND end when data and finished status arrive together', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'final' }, { [HEADER_STATUS]: 'finished' }),
      );

      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toEqual({ kind: 'event', event: { type: 'delta', streamId: 'id-1', delta: 'final' } });
      expect(outputs[1]).toEqual({ kind: 'event', event: { type: 'end', streamId: 'id-1' } });
    });

    it('falls through to update for unknown serial', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 'unknown', name: 'user-message', data: 'data' }, { [HEADER_STREAM]: 'false' }),
      );
      expect(outputs).toHaveLength(1);
    });

    it('skips empty deltas but still processes status', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'finished' }),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'end', streamId: 'id-1' } }]);
    });

    it('handles non-string data by treating as empty delta', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 123 }, {}),
      );

      expect(outputs).toHaveLength(0);
    });
  });

  // -- message.update (first-contact) --------------------------------------

  describe('message.update (first-contact)', () => {
    it('creates tracker for first-contact streamed update with data', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'accumulated' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toEqual({ kind: 'event', event: { type: 'start', streamId: 'id-1' } });
      expect(outputs[1]).toEqual({ kind: 'event', event: { type: 'delta', streamId: 'id-1', delta: 'accumulated' } });
    });

    it('emits start + delta + end for first-contact finished stream', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'all data' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'finished', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      expect(outputs).toHaveLength(3);
      expect((outputs[0] as { kind: 'event'; event: TestEvent }).event.type).toBe('start');
      expect((outputs[1] as { kind: 'event'; event: TestEvent }).event.type).toBe('delta');
      expect((outputs[2] as { kind: 'event'; event: TestEvent }).event.type).toBe('end');
    });

    it('emits only start for first-contact aborted stream (no end events)', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: '' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'aborted', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect((outputs[0] as { kind: 'event'; event: TestEvent }).event.type).toBe('start');
    });

    it('treats non-streamed first-contact as discrete', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders({ action: 'message.update', serial: 's1', name: 'user-message', data: 'updated' }, { [HEADER_STREAM]: 'false' }),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'discrete', name: 'user-message', data: 'updated' } }]);
    });
  });

  // -- message.update (prefix-match) ---------------------------------------

  describe('message.update (prefix-match)', () => {
    it('emits delta for new content when data extends accumulated', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello world' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming' },
        ),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'delta', streamId: 'id-1', delta: ' world' } }]);
    });

    it('emits end on prefix-match with finished status', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'finished' },
        ),
      );

      expect(outputs).toEqual([{ kind: 'event', event: { type: 'end', streamId: 'id-1' } }]);
    });

    it('returns empty when data matches exactly and still streaming', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming' },
        ),
      );

      expect(outputs).toHaveLength(0);
    });
  });

  // -- message.update (replacement) ----------------------------------------

  describe('message.update (replacement)', () => {
    it('calls onStreamUpdate for non-prefix replacement', () => {
      const onUpdate = vi.fn();
      const decoder = createDecoderCore(hooks, { onStreamUpdate: onUpdate });

      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'completely different' },
          { [HEADER_STREAM]: 'true' },
        ),
      );

      expect(outputs).toHaveLength(0);
      expect(onUpdate).toHaveBeenCalledOnce();
    });
  });

  // -- message.delete ------------------------------------------------------

  describe('message.delete', () => {
    it('calls onStreamDelete with serial and tracker state before clearing', () => {
      let capturedAccumulated: string | undefined;
      const onDelete = vi.fn((_serial: string, tracker: { accumulated: string } | undefined) => {
        capturedAccumulated = tracker?.accumulated;
      });
      const decoder = createDecoderCore(hooks, { onStreamDelete: onDelete });

      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'content' }, {}));
      decoder.decode(withHeaders({ action: 'message.delete', serial: 's1' }, {}));

      expect(onDelete).toHaveBeenCalledOnce();
      expect(capturedAccumulated).toBe('content');
    });

    it('calls onStreamDelete with undefined tracker for unknown serial', () => {
      const onDelete = vi.fn();
      const decoder = createDecoderCore(hooks, { onStreamDelete: onDelete });

      decoder.decode(withHeaders({ action: 'message.delete', serial: 'unknown' }, {}));

      expect(onDelete).toHaveBeenCalledWith('unknown', undefined);
    });

    it('returns empty for missing serial', () => {
      const decoder = createDecoderCore(hooks);
      expect(decoder.decode(withHeaders({ action: 'message.delete', serial: undefined }, {}))).toEqual([]);
    });
  });

  // -- unknown action ------------------------------------------------------

  describe('unknown action', () => {
    it('returns empty array', () => {
      const decoder = createDecoderCore(hooks);
      expect(
        decoder.decode(
          withHeaders({ action: 'message.summary' as Ably.InboundMessage['action'] }, {}),
        ),
      ).toEqual([]);
    });
  });

  // -- callback error isolation --------------------------------------------

  describe('callback error isolation', () => {
    it('does not propagate errors from onStreamUpdate callback', () => {
      const decoder = createDecoderCore(hooks, {
        onStreamUpdate: () => {
          throw new Error('callback error');
        },
      });

      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));

      // Non-prefix replacement triggers onStreamUpdate — should not throw
      expect(() => {
        decoder.decode(
          withHeaders(
            { action: 'message.update', serial: 's1', name: 'text', data: 'different' },
            { [HEADER_STREAM]: 'true' },
          ),
        );
      }).not.toThrow();
    });

    it('does not propagate errors from onStreamDelete callback', () => {
      const decoder = createDecoderCore(hooks, {
        onStreamDelete: () => {
          throw new Error('callback error');
        },
      });

      expect(() => {
        decoder.decode(withHeaders({ action: 'message.delete', serial: 's1' }, {}));
      }).not.toThrow();
    });
  });

  // -- full stream lifecycle -----------------------------------------------

  describe('stream lifecycle', () => {
    it('handles complete lifecycle: create → append → append → close', () => {
      const decoder = createDecoderCore(hooks);

      const start = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      expect(start).toEqual([{ kind: 'event', event: { type: 'start', streamId: 'id-1' } }]);

      const delta1 = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'Hello' }, {}));
      expect(delta1).toEqual([{ kind: 'event', event: { type: 'delta', streamId: 'id-1', delta: 'Hello' } }]);

      const delta2 = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: ' world' }, {}));
      expect(delta2).toEqual([{ kind: 'event', event: { type: 'delta', streamId: 'id-1', delta: ' world' } }]);

      const end = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'finished' }),
      );
      expect(end).toEqual([{ kind: 'event', event: { type: 'end', streamId: 'id-1' } }]);
    });

    it('handles create → abort (no end events)', () => {
      const decoder = createDecoderCore(hooks);

      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const abort = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'aborted' }),
      );

      expect(abort).toHaveLength(0);
    });
  });

  // -- messageId tagging -------------------------------------------------------

  describe('x-ably-msg-id tagging', () => {
    it('tags streamed event outputs with messageId from x-ably-msg-id header', () => {
      const decoder = createDecoderCore(createMockHooks());
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'sid-1', [HEADER_MSG_ID]: 'msg-42' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual(expect.objectContaining({ kind: 'event', messageId: 'msg-42' }));
    });

    it('tags discrete event outputs with messageId from x-ably-msg-id header', () => {
      const decoder = createDecoderCore(createMockHooks());
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create' },
          { [HEADER_STREAM]: 'false', [HEADER_MSG_ID]: 'msg-99' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual(expect.objectContaining({ kind: 'event', messageId: 'msg-99' }));
    });

    it('does not set messageId when x-ably-msg-id header is absent', () => {
      const decoder = createDecoderCore(createMockHooks());
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create' },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual(expect.objectContaining({ kind: 'event' }));
      expect((outputs[0] as { messageId?: string }).messageId).toBeUndefined();
    });

    it('tags append event outputs with messageId', () => {
      const decoder = createDecoderCore(createMockHooks());

      // Create a stream first
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'sid-1', [HEADER_MSG_ID]: 'msg-1' },
        ),
      );

      // Append with msg-id
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', data: 'delta' },
          { [HEADER_MSG_ID]: 'msg-1' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual(expect.objectContaining({ kind: 'event', messageId: 'msg-1' }));
    });
  });
});
