import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { createDecoderCore } from '../../../src/core/codec/decoder.js';
import type { Logger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Ably InboundMessage helper
// ---------------------------------------------------------------------------

interface MessageOptions {
  action?: Ably.InboundMessage['action'];
  serial?: string;
  data?: unknown;
  version?: string;
  /** Fields under `extras.ai` beside the type: the transport's `stream` and `ends` markers. */
  ai?: Record<string, unknown>;
}

const message = (opts: MessageOptions): Ably.InboundMessage =>
  ({
    action: opts.action ?? 'message.create',
    serial: 'serial' in opts ? opts.serial : 's1',
    data: 'data' in opts ? opts.data : '',
    version: opts.version === undefined ? {} : { serial: opts.version },
    extras: { ai: { type: 'text', ...opts.ai } },
    // CAST: a minimal InboundMessage stub carrying only the fields the core reads.
  }) as Ably.InboundMessage;

/**
 * A create the pipe writer marked as a stream's message.
 * @param opts - The serial, data and version.
 * @returns The inbound message.
 */
const opener = (opts: Omit<MessageOptions, 'action' | 'ai'>): Ably.InboundMessage =>
  message({ ...opts, action: 'message.create', ai: { stream: true } });

const createMockLogger = (): { logger: Logger; debug: ReturnType<typeof vi.fn> } => {
  const debug = vi.fn();
  const logger: Logger = {
    trace: vi.fn(),
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => logger,
  };
  return { logger, debug };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDecoderCore', () => {
  describe('message.create', () => {
    it('hands a create on as it is', () => {
      const core = createDecoderCore();
      const create = opener({ data: 'hello' });
      expect(core.prepare(create)).toBe(create);
    });

    it('drops a second create for a tracked serial', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: 'hello' }));
      expect(core.prepare(opener({ data: 'hello' }))).toBeUndefined();
    });

    it('hands a create with no stream marker on without tracking it', () => {
      const core = createDecoderCore();
      const plain = message({ data: 'hello' });
      expect(core.prepare(plain)).toBe(plain);
      // Not remembered: a replay decodes again, and an update for it is first
      // contact with its full content rather than a tail.
      expect(core.prepare(plain)).toBe(plain);
      const update = message({ action: 'message.update', data: 'hello world', version: 's1:v2' });
      expect(core.prepare(update)).toBe(update);
    });

    it('hands a message with no serial on without tracking it', () => {
      const core = createDecoderCore();
      const untracked = opener({ serial: undefined, data: 'x' });
      expect(core.prepare(untracked)).toBe(untracked);
      expect(core.prepare(untracked)).toBe(untracked);
    });
  });

  describe('message.append', () => {
    it('hands an append for a tracked serial on as it is', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: '' }));
      const append = message({ action: 'message.append', data: 'Hello', version: 's1:v2' });
      expect(core.prepare(append)).toBe(append);
    });

    it('hands an append for an untracked serial on as first contact', () => {
      const core = createDecoderCore();
      const append = message({ action: 'message.append', data: 'Hello', version: 's1:v2' });
      expect(core.prepare(append)).toBe(append);
      // The append's content is now the baseline, so an update extending it reduces to the tail.
      const update = message({ action: 'message.update', data: 'Hello world', version: 's1:v3' });
      expect(core.prepare(update)?.data).toBe(' world');
    });

    it('drops an append whose version is already incorporated', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: '', version: 's1' }));
      core.prepare(message({ action: 'message.append', data: 'Hello', version: 's1:v2' }));
      expect(core.prepare(message({ action: 'message.append', data: 'Hello', version: 's1:v2' }))).toBeUndefined();
      expect(core.prepare(message({ action: 'message.append', data: 'x', version: 's1' }))).toBeUndefined();
    });

    it('accumulates appended text for a later prefix match', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: '' }));
      core.prepare(message({ action: 'message.append', data: 'The weather', version: 's1:v2' }));
      core.prepare(message({ action: 'message.append', data: ' in London', version: 's1:v3' }));
      const update = message({ action: 'message.update', data: 'The weather in London is mild.', version: 's1:v4' });
      expect(core.prepare(update)?.data).toBe(' is mild.');
    });
  });

  describe('message.update', () => {
    it('reduces a full-content update to the unseen tail', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: 'The weather' }));
      const update = message({ action: 'message.update', data: 'The weather in London', version: 's1:v2' });
      const prepared = core.prepare(update);
      expect(prepared?.data).toBe(' in London');
      expect(prepared?.serial).toBe('s1');
      expect(prepared?.action).toBe('message.update');
      expect(prepared?.extras).toEqual(update.extras);
    });

    it('drops an update that adds nothing', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: 'The weather' }));
      expect(
        core.prepare(message({ action: 'message.update', data: 'The weather', version: 's1:v2' })),
      ).toBeUndefined();
    });

    it('hands a first-contact update on with its full content', () => {
      const core = createDecoderCore();
      const update = message({ action: 'message.update', data: 'The weather in London', version: 's1:v3' });
      expect(core.prepare(update)).toBe(update);
    });

    it('hands a replacement on with its full content and moves the baseline', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: 'The weather' }));
      const replacement = message({ action: 'message.update', data: 'Sunny in London', version: 's1:v2' });
      expect(core.prepare(replacement)).toBe(replacement);
      const next = message({ action: 'message.update', data: 'Sunny in London today', version: 's1:v3' });
      expect(core.prepare(next)?.data).toBe(' today');
    });

    it('drops an update whose version is already incorporated', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: '' }));
      core.prepare(message({ action: 'message.append', data: 'Hello', version: 's1:v2' }));
      core.prepare(message({ action: 'message.append', data: ' world', version: 's1:v3' }));
      // A history read that caught the message at v2 arrives after live reached v3.
      expect(core.prepare(message({ action: 'message.update', data: 'Hello', version: 's1:v2' }))).toBeUndefined();
    });

    it('treats a history aggregate at the incorporated version as already seen', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: '' }));
      core.prepare(message({ action: 'message.append', data: 'Hello', version: 's1:v2' }));
      expect(core.prepare(message({ action: 'message.update', data: 'Hello', version: 's1:v2' }))).toBeUndefined();
    });
  });

  describe('message.delete', () => {
    it('returns nothing for a delete', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: 'Hello' }));
      expect(core.prepare(message({ action: 'message.delete', data: '', version: 's1:v9' }))).toBeUndefined();
    });

    it('forgets the serial on a delete, so a later delivery for it is first contact', () => {
      const core = createDecoderCore();
      core.prepare(opener({ data: 'Hello' }));
      core.prepare(message({ action: 'message.delete', data: '', version: 's1:v9' }));
      const update = message({ action: 'message.update', data: 'Hello again', version: 's1:v10' });
      expect(core.prepare(update)).toBe(update);
    });
  });

  describe('stream end', () => {
    it('forgets the serial a closer names, so a later delivery for it is first contact', () => {
      const { logger, debug } = createMockLogger();
      const core = createDecoderCore({ logger });
      core.prepare(opener({ serial: 's1', data: 'Hello' }));
      core.prepare(message({ serial: 's1', action: 'message.append', data: ' world', version: 's1:v2' }));
      const closer = message({ serial: 's2', ai: { ends: 's1' } });
      // The closer is itself handed on.
      expect(core.prepare(closer)).toBe(closer);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('stream ended'), { serial: 's1' });
      // s1 is forgotten: an update for it carries its full content, not a tail.
      const update = message({ serial: 's1', action: 'message.update', data: 'Hello world!', version: 's1:v3' });
      expect(core.prepare(update)).toBe(update);
    });

    it('ignores a closer for a serial it does not hold', () => {
      const { logger, debug } = createMockLogger();
      const core = createDecoderCore({ logger });
      const closer = message({ serial: 's2', ai: { ends: 's1' } });
      expect(core.prepare(closer)).toBe(closer);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('closer for an untracked serial'), { serial: 's1' });
    });

    it('reduces an append that ends its own serial before forgetting it', () => {
      const core = createDecoderCore();
      core.prepare(opener({ serial: 's1', data: 'Hello' }));
      const last = message({ serial: 's1', action: 'message.append', data: '!', version: 's1:v2', ai: { ends: 's1' } });
      expect(core.prepare(last)).toBe(last);
      const replay = message({ serial: 's1', action: 'message.append', data: '!', version: 's1:v2' });
      // Forgotten, so the replay is first contact rather than a dropped duplicate.
      expect(core.prepare(replay)).toBe(replay);
    });
  });

  describe('other actions', () => {
    it('hands an action it does not track on as it is', () => {
      const core = createDecoderCore();
      const other = message({ action: 'message.summary' });
      expect(core.prepare(other)).toBe(other);
    });
  });
});
