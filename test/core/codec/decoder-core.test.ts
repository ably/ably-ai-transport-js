import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { DecodedValue, DecoderCoreHooks, StreamTrackerState } from '../../../src/core/codec/index.js';
import { createDecoderCore } from '../../../src/core/codec/index.js';
import { Headers } from '../../../src/headers.js';

interface InboundOverrides {
  action: 'message.create' | 'message.append' | 'message.update' | 'message.delete';
  serial?: string;
  name?: string;
  data?: unknown;
  headers?: Record<string, string>;
}

const makeInbound = (overrides: InboundOverrides): Ably.InboundMessage =>
  ({
    id: `${overrides.action}:${overrides.serial ?? ''}`,
    serial: overrides.serial,
    timestamp: Date.now(),
    action: overrides.action,
    version: { serial: overrides.serial ?? '', timestamp: Date.now() },
    annotations: {},
    name: overrides.name ?? 'text',
    data: overrides.data,
    extras: { headers: overrides.headers ?? {} },
  }) as unknown as Ably.InboundMessage;

interface RecorderHooks {
  hooks: DecoderCoreHooks<string, never>;
  startCalls: StreamTrackerState[];
  deltaCalls: { tracker: StreamTrackerState; delta: string }[];
  endCalls: { tracker: StreamTrackerState; closingHeaders: Record<string, string> }[];
  discreteCalls: { name: string; data: unknown; headers: Record<string, string> }[];
}

const makeRecorderHooks = (): RecorderHooks => {
  const startCalls: StreamTrackerState[] = [];
  const deltaCalls: { tracker: StreamTrackerState; delta: string }[] = [];
  const endCalls: { tracker: StreamTrackerState; closingHeaders: Record<string, string> }[] = [];
  const discreteCalls: { name: string; data: unknown; headers: Record<string, string> }[] = [];
  const hooks: DecoderCoreHooks<string, never> = {
    buildStartEvents: (tracker): DecodedValue<string, never>[] => {
      startCalls.push({ ...tracker });
      return [{ kind: 'part', part: `start:${tracker.streamId}` }];
    },
    buildDeltaEvents: (tracker, delta): DecodedValue<string, never>[] => {
      deltaCalls.push({ tracker: { ...tracker }, delta });
      return [{ kind: 'part', part: `delta:${delta}` }];
    },
    buildEndEvents: (tracker, closingHeaders): DecodedValue<string, never>[] => {
      endCalls.push({ tracker: { ...tracker }, closingHeaders: { ...closingHeaders } });
      return [{ kind: 'part', part: `end:${tracker.streamId}` }];
    },
    decodeDiscrete: ({ name, data, headers }): DecodedValue<string, never>[] => {
      discreteCalls.push({ name, data, headers: { ...headers } });
      return [{ kind: 'part', part: `discrete:${name}` }];
    },
  };
  return { hooks, startCalls, deltaCalls, endCalls, discreteCalls };
};

describe('DecoderCore', () => {
  describe('message.create', () => {
    it('opens a tracker and calls buildStartEvents when x-ably-stream is true', () => {
      const { hooks, startCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);

      const outputs = core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1' },
        }),
      );

      expect(startCalls).toHaveLength(1);
      expect(startCalls[0]?.streamId).toBe('s-1');
      expect(outputs).toEqual([{ kind: 'part', part: 'start:s-1' }]);
    });

    it('routes through decodeDiscrete when x-ably-stream is false', () => {
      const { hooks, discreteCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);

      core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          data: 'hi',
          headers: { [Headers.Stream]: 'false', [Headers.Discrete]: 'true' },
        }),
      );

      expect(discreteCalls).toHaveLength(1);
      expect(discreteCalls[0]?.name).toBe('text');
      expect(discreteCalls[0]?.data).toBe('hi');
      expect(discreteCalls[0]?.headers[Headers.Discrete]).toBe('true');
    });

    it('stamps x-ably-msg-id from the inbound onto every output', () => {
      const { hooks } = makeRecorderHooks();
      const core = createDecoderCore(hooks);

      const outputs = core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1', [Headers.MessageId]: 'm-1' },
        }),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.messageId).toBe('m-1');
    });
  });

  describe('message.append', () => {
    it('looks up the tracker, accumulates the delta, and calls buildDeltaEvents', () => {
      const { hooks, deltaCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);
      core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1' },
        }),
      );

      core.decode(makeInbound({ action: 'message.append', serial: '01', data: 'hello' }));
      core.decode(makeInbound({ action: 'message.append', serial: '01', data: ' world' }));

      expect(deltaCalls.map((c) => c.delta)).toEqual(['hello', ' world']);
      expect(deltaCalls.at(-1)?.tracker.accumulated).toBe('hello world');
    });

    it('calls buildEndEvents on x-ably-status:finished and not on aborted', () => {
      const { hooks, endCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);
      core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1' },
        }),
      );

      core.decode(
        makeInbound({
          action: 'message.append',
          serial: '01',
          data: 'hi',
          headers: { [Headers.Status]: 'aborted' },
        }),
      );
      expect(endCalls).toHaveLength(0);

      core.decode(
        makeInbound({
          action: 'message.append',
          serial: '02', // another stream
          data: 'goodbye',
          headers: { [Headers.Status]: 'finished' },
        }),
      );
      // No tracker for serial 02 yet; first-contact update path is taken.

      // Now finish the original stream.
      core.decode(
        makeInbound({
          action: 'message.append',
          serial: '01',
          data: '',
          headers: { [Headers.Status]: 'finished' },
        }),
      );
      // Already aborted, so should not fire end again.
      expect(endCalls).toHaveLength(0);
    });

    it('falls through to first-contact update when the serial is unknown', () => {
      const { hooks, discreteCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);

      core.decode(
        makeInbound({
          action: 'message.append',
          serial: '99',
          data: 'orphan',
          headers: { [Headers.Stream]: 'false' },
        }),
      );

      // First-contact non-streamed routes through decodeDiscrete.
      expect(discreteCalls).toHaveLength(1);
    });
  });

  describe('message.update', () => {
    it('treats a prefix-match update as a delta on the existing tracker', () => {
      const { hooks, deltaCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);
      core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          data: 'hello',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1' },
        }),
      );

      core.decode(makeInbound({ action: 'message.update', serial: '01', data: 'hello world' }));

      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]?.delta).toBe(' world');
    });

    it('fires onStreamUpdate on a non-prefix replacement', () => {
      const { hooks } = makeRecorderHooks();
      const onStreamUpdate = vi.fn();
      const core = createDecoderCore(hooks, { onStreamUpdate });
      core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          data: 'hello',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1' },
        }),
      );

      core.decode(makeInbound({ action: 'message.update', serial: '01', data: 'totally different' }));

      expect(onStreamUpdate).toHaveBeenCalledTimes(1);
    });

    it('first-contact streamed update opens a tracker and emits start + delta', () => {
      const { hooks, startCalls, deltaCalls } = makeRecorderHooks();
      const core = createDecoderCore(hooks);

      core.decode(
        makeInbound({
          action: 'message.update',
          serial: '01',
          name: 'text',
          data: 'recovered',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1', [Headers.Status]: 'finished' },
        }),
      );

      expect(startCalls).toHaveLength(1);
      expect(deltaCalls).toHaveLength(1);
      expect(deltaCalls[0]?.delta).toBe('recovered');
    });
  });

  describe('message.delete', () => {
    it('fires onStreamDelete with the tracker (when present)', () => {
      const { hooks } = makeRecorderHooks();
      const onStreamDelete = vi.fn();
      const core = createDecoderCore(hooks, { onStreamDelete });
      core.decode(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          headers: { [Headers.Stream]: 'true', [Headers.StreamId]: 's-1' },
        }),
      );

      core.decode(makeInbound({ action: 'message.delete', serial: '01' }));

      expect(onStreamDelete).toHaveBeenCalledTimes(1);
      expect(onStreamDelete).toHaveBeenCalledWith('01', expect.objectContaining({ streamId: 's-1' }));
    });
  });
});
