import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_STATUS, HEADER_STREAM, HEADER_STREAM_ID } from '../../../src/constants.js';
import type { DecoderCoreHooks } from '../../../src/core/codec/decoder.js';
import { createDecoderCore } from '../../../src/core/codec/decoder.js';
import type { Logger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Test event type
// ---------------------------------------------------------------------------

type TestEvent =
  | { type: 'start'; streamId: string }
  | { type: 'delta'; streamId: string; delta: string }
  | { type: 'end'; streamId: string }
  | { type: 'discrete'; name: string; data: string };

// ---------------------------------------------------------------------------
// Mock hooks factory
// ---------------------------------------------------------------------------

const createMockHooks = (): DecoderCoreHooks<TestEvent> => ({
  buildStartEvents: (tracker) => [{ type: 'start', streamId: tracker.streamId }],
  buildDeltaEvents: (tracker, delta) => [{ type: 'delta', streamId: tracker.streamId, delta }],
  buildEndEvents: (tracker) => [{ type: 'end', streamId: tracker.streamId }],
  decodeDiscrete: (input) => [
    { type: 'discrete', name: input.name, data: typeof input.data === 'string' ? input.data : '' },
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
    // `version` is required on InboundMessage; its `serial` is optional.
    // Fixtures that exercise the version guard override it.
    version: {},
    ...msg,
    extras: { ai: { transport: headers } },
    // CAST: Tests construct a minimal Ably.InboundMessage stub; full shape isn't needed for these tests.
  }) as Ably.InboundMessage;

/**
 * Build a foreign wire — an application's own publish on a channel it shares
 * with a session. It carries no `extras.ai` envelope; anything under
 * `extras.headers` belongs to the application.
 * @param msg - Fields overriding the foreign message defaults.
 * @returns The foreign InboundMessage.
 */
const foreignMessage = (msg: Partial<Ably.InboundMessage>): Ably.InboundMessage =>
  ({
    serial: 'foreign-1',
    action: 'message.create',
    name: 'chat.message',
    data: { text: 'hello from the app' },
    version: { serial: 'foreign-1' },
    extras: { headers: { topic: 'support' } },
    ...msg,
    // CAST: Tests construct a minimal Ably.InboundMessage stub; full shape isn't needed.
  }) as Ably.InboundMessage;

/**
 * Capture-friendly Logger stub: records `warn` calls, no-ops everything else,
 * and returns itself from `withContext` so the decoder's child logger shares
 * the same spies.
 * @returns The stub logger and its `warn` spy.
 */
const createMockLogger = (): { logger: Logger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    withContext: () => logger,
  };
  return { logger, warn };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDecoderCore', () => {
  let hooks: DecoderCoreHooks<TestEvent>;

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

      expect(outputs).toEqual([{ type: 'start', streamId: 'id-1' }]);
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

      expect(outputs).toEqual([{ type: 'discrete', name: 'user-message', data: 'hello' }]);
    });

    it('handles non-string data by defaulting to empty string', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders({ action: 'message.create', name: 'user-message', data: 42 }, { [HEADER_STREAM]: 'false' }),
      );

      expect(outputs[0]).toEqual({ type: 'discrete', name: 'user-message', data: '' });
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
      expect(outputs).toEqual([{ type: 'delta', streamId: 'id-1', delta: 'hello' }]);
    });

    it('emits end events when status is complete', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'complete' }),
      );

      expect(outputs).toEqual([{ type: 'end', streamId: 'id-1' }]);
    });

    it('does not emit end after cancel (closed flag prevents duplicate)', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'cancelled' }),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'complete' }),
      );

      expect(outputs).toHaveLength(0);
    });

    it('emits delta AND end when data and complete status arrive together', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'final' }, { [HEADER_STATUS]: 'complete' }),
      );

      expect(outputs).toHaveLength(2);
      expect(outputs[0]).toEqual({ type: 'delta', streamId: 'id-1', delta: 'final' });
      expect(outputs[1]).toEqual({ type: 'end', streamId: 'id-1' });
    });

    it('falls through to update for unknown serial', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 'unknown', name: 'user-message', data: 'data' },
          { [HEADER_STREAM]: 'false' },
        ),
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
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'complete' }),
      );

      expect(outputs).toEqual([{ type: 'end', streamId: 'id-1' }]);
    });

    it('handles non-string data by treating as empty delta', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const outputs = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 123 }, {}));

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
      expect(outputs[0]).toEqual({ type: 'start', streamId: 'id-1' });
      expect(outputs[1]).toEqual({ type: 'delta', streamId: 'id-1', delta: 'accumulated' });
    });

    it('emits start + delta + end for first-contact complete stream', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'all data' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'complete', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      expect(outputs).toHaveLength(3);
      expect(outputs[0]?.type).toBe('start');
      expect(outputs[1]?.type).toBe('delta');
      expect(outputs[2]?.type).toBe('end');
    });

    it('emits only start for first-contact cancelled stream (no end events)', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: '' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'cancelled', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.type).toBe('start');
    });

    it('treats non-streamed first-contact as discrete', () => {
      const decoder = createDecoderCore(hooks);
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'user-message', data: 'updated' },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      expect(outputs).toEqual([{ type: 'discrete', name: 'user-message', data: 'updated' }]);
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

      expect(outputs).toEqual([{ type: 'delta', streamId: 'id-1', delta: ' world' }]);
    });

    it('emits end on prefix-match with complete status', () => {
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
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'complete' },
        ),
      );

      expect(outputs).toEqual([{ type: 'end', streamId: 'id-1' }]);
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
      expect(decoder.decode(withHeaders({ action: 'message.summary' }, {}))).toEqual([]);
    });
  });

  // -- foreign messages ----------------------------------------------------
  //
  // An application may publish its own messages on a channel it shares with a
  // session. Those wires carry no `extras.ai` envelope, and the core must merge
  // none of them into codec events or stream state.

  describe('foreign messages', () => {
    it('ignores a foreign append instead of treating it as a first-contact stream', () => {
      const { logger, warn } = createMockLogger();
      const decoder = createDecoderCore(hooks, { logger });

      // An application streaming its own message publishes appends the core has
      // no create for. Ably does not echo `name` on an append, so the missing
      // `extras.ai` envelope is what identifies it as foreign.
      const outputs = decoder.decode(foreignMessage({ action: 'message.append', serial: 'f1', data: 'chunk' }));

      expect(outputs).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('opens no stream state for a foreign create, so its later appends stay foreign', () => {
      const { logger, warn } = createMockLogger();
      const decoder = createDecoderCore(hooks, { logger });

      decoder.decode(foreignMessage({ action: 'message.create', serial: 'f1', data: 'chunk one' }));
      const outputs = decoder.decode(foreignMessage({ action: 'message.append', serial: 'f1', data: 'chunk two' }));

      expect(outputs).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('still warns for a trackerless append that carries the ai envelope', () => {
      const { logger, warn } = createMockLogger();
      const decoder = createDecoderCore(hooks, { logger });

      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', name: 'text', data: 'chunk' }, {}));

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('leaves an in-flight stream untouched when foreign wires interleave', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'Hel' }, {}));
      decoder.decode(foreignMessage({ action: 'message.create', serial: 'f1', data: { text: 'unrelated' } }));
      decoder.decode(foreignMessage({ action: 'message.append', serial: 'f2', data: 'unrelated' }));

      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'lo' }, { [HEADER_STATUS]: 'complete' }),
      );

      // The stream accumulated exactly its own deltas: the closing append is a
      // clean continuation, not a replacement.
      expect(outputs).toEqual([
        { type: 'delta', streamId: 'id-1', delta: 'lo' },
        { type: 'end', streamId: 'id-1' },
      ]);
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
    it('handles complete lifecycle: create -> append -> append -> close', () => {
      const decoder = createDecoderCore(hooks);

      const start = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      expect(start).toEqual([{ type: 'start', streamId: 'id-1' }]);

      const delta1 = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'Hello' }, {}));
      expect(delta1).toEqual([{ type: 'delta', streamId: 'id-1', delta: 'Hello' }]);

      const delta2 = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: ' world' }, {}));
      expect(delta2).toEqual([{ type: 'delta', streamId: 'id-1', delta: ' world' }]);

      const end = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'complete' }),
      );
      expect(end).toEqual([{ type: 'end', streamId: 'id-1' }]);
    });

    it('handles create -> cancel (no end events)', () => {
      const decoder = createDecoderCore(hooks);

      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );

      const cancel = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'cancelled' }),
      );

      expect(cancel).toHaveLength(0);
    });
  });

  // -- version guard ---------------------------------------------------------

  describe('version guard', () => {
    // A subscriber that attaches while a message is mid-stream receives the
    // first post-attach append as a full-contents update (platform
    // conversion), so the live route and the history-hydration route both
    // deliver full state. The version guard decides which deliveries the
    // shared tracker has already incorporated.

    const streamedHeaders = {
      [HEADER_STREAM]: 'true',
      [HEADER_STATUS]: 'streaming',
      [HEADER_STREAM_ID]: 'id-1',
    };

    it('decodes the history aggregate to nothing when the live converted update arrived first', () => {
      const decoder = createDecoderCore(hooks);

      // Live route wins the race: converted full-contents update.
      const live = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:03' } },
          streamedHeaders,
        ),
      );
      expect(live).toEqual([
        { type: 'start', streamId: 'id-1' },
        { type: 'delta', streamId: 'id-1', delta: 'hello' },
      ]);

      // Hydration lands later: the untilAttach aggregate is bounded at attach,
      // so it carries a strictly older version and a prefix of the content.
      const aggregate = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hel', version: { serial: 's1:02' } },
          streamedHeaders,
        ),
      );
      expect(aggregate).toEqual([]);
    });

    it('drops a stale aggregate after the live route has advanced past it', () => {
      const decoder = createDecoderCore(hooks);

      decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:02' } },
          streamedHeaders,
        ),
      );
      const delta = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: ' world', version: { serial: 's1:03' } }, {}),
      );
      expect(delta).toEqual([{ type: 'delta', streamId: 'id-1', delta: ' world' }]);

      // The stale aggregate's data is not a prefix extension of the tracker's
      // accumulated text — without the version guard it would be treated as a
      // stream replacement and corrupt the projection.
      const stale = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:02' } },
          streamedHeaders,
        ),
      );
      expect(stale).toEqual([]);
    });

    it('decodes a same-version full-state redelivery to nothing', () => {
      const decoder = createDecoderCore(hooks);

      const aggregate = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:02' } },
          streamedHeaders,
        ),
      );
      expect(aggregate).toEqual([
        { type: 'start', streamId: 'id-1' },
        { type: 'delta', streamId: 'id-1', delta: 'hello' },
      ]);

      // The same full-state delivery again (whole-wire replay): same mutation,
      // same version, already incorporated.
      const redelivered = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:02' } },
          streamedHeaders,
        ),
      );
      expect(redelivered).toEqual([]);
    });

    it('merges exactly the suffix when the converted update is newer than the hydration aggregate', () => {
      const decoder = createDecoderCore(hooks);

      // Hydration lands first: the untilAttach aggregate is bounded at attach.
      const aggregate = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:02' } },
          streamedHeaders,
        ),
      );
      expect(aggregate).toEqual([
        { type: 'start', streamId: 'id-1' },
        { type: 'delta', streamId: 'id-1', delta: 'hello' },
      ]);

      // The converted update is the first post-attach mutation — always a
      // strictly newer superset of the attach-bounded aggregate, so it must
      // continue the stream, not be dropped.
      const converted = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello world', version: { serial: 's1:03' } },
          streamedHeaders,
        ),
      );
      expect(converted).toEqual([{ type: 'delta', streamId: 'id-1', delta: ' world' }]);

      // Plain appends continue from the advanced version.
      const next = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '!', version: { serial: 's1:04' } }, {}),
      );
      expect(next).toEqual([{ type: 'delta', streamId: 'id-1', delta: '!' }]);
    });

    it('advances on a version-bearing append and drops its replay', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(withHeaders({ action: 'message.create', serial: 's1', name: 'text' }, streamedHeaders));

      const first = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'a', version: { serial: 's1:01' } }, {}),
      );
      expect(first).toEqual([{ type: 'delta', streamId: 'id-1', delta: 'a' }]);

      // Resume retransmission: the same mutation carries the same version.
      const replay = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'a', version: { serial: 's1:01' } }, {}),
      );
      expect(replay).toEqual([]);

      const next = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'b', version: { serial: 's1:02' } }, {}),
      );
      expect(next).toEqual([{ type: 'delta', streamId: 'id-1', delta: 'b' }]);
    });

    it('drops a duplicate create for a tracked stream', () => {
      const decoder = createDecoderCore(hooks);
      const create = withHeaders({ action: 'message.create', serial: 's1', name: 'text' }, streamedHeaders);

      expect(decoder.decode(create)).toEqual([{ type: 'start', streamId: 'id-1' }]);
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));

      // A replayed create must not reset the tracker's accumulated state.
      expect(decoder.decode(create)).toEqual([]);
      const delta = decoder.decode(
        withHeaders({ action: 'message.update', serial: 's1', name: 'text', data: 'hello world' }, streamedHeaders),
      );
      expect(delta).toEqual([{ type: 'delta', streamId: 'id-1', delta: ' world' }]);
    });

    it('decodes a replayed aggregate for a closed stream to nothing', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(withHeaders({ action: 'message.create', serial: 's1', name: 'text' }, streamedHeaders));
      decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: 'hello', version: { serial: 's1:01' } }, {}),
      );
      decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', data: '', version: { serial: 's1:02' } },
          { [HEADER_STATUS]: 'complete' },
        ),
      );

      // Whole-wire replay (second hydration): the history aggregate carries
      // the closed stream's full contents at its final version.
      const replay = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello', version: { serial: 's1:02' } },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'complete', [HEADER_STREAM_ID]: 'id-1' },
        ),
      );
      expect(replay).toEqual([]);
    });

    it('drops an out-of-contract version-less delivery for a closed stream', () => {
      const decoder = createDecoderCore(hooks);
      decoder.decode(withHeaders({ action: 'message.create', serial: 's1', name: 'text' }, streamedHeaders));
      decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'hello' }, {}));
      decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', data: '' }, { [HEADER_STATUS]: 'complete' }),
      );

      // The closed tracker's accumulated text is tombstoned, so a late
      // version-less delta must be dropped rather than merged.
      const late = decoder.decode(withHeaders({ action: 'message.append', serial: 's1', data: 'more' }, {}));
      expect(late).toEqual([]);
    });

    it('warns and falls back to first contact for a bare no-tracker append', () => {
      const { logger, warn } = createMockLogger();
      const decoder = createDecoderCore(hooks, { logger });

      // Out of contract: the platform converts the first post-attach append of
      // an in-flight message into a full-contents update, so a bare append
      // should never be first contact — but the heuristic still recovers it.
      const outputs = decoder.decode(
        withHeaders({ action: 'message.append', serial: 's1', name: 'text', data: 'hello' }, streamedHeaders),
      );

      expect(outputs).toEqual([
        { type: 'start', streamId: 'id-1' },
        { type: 'delta', streamId: 'id-1', delta: 'hello' },
      ]);
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
