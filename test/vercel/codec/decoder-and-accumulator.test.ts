import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { Headers } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createAccumulator } from '../../../src/vercel/codec/accumulator.js';
import { createDecoder } from '../../../src/vercel/codec/decoder.js';

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

const persistentToolInputHeaders = (overrides: Record<string, string> = {}): Record<string, string> => ({
  [Headers.Stream]: 'true',
  [Headers.StreamId]: 't-1',
  [Headers.MessageId]: 'tool-msg',
  'x-domain-toolName': 'getWeather',
  ...overrides,
});

const makeStack = () => {
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const decoder = createDecoder(logger);
  const accumulator = createAccumulator(logger);
  // Drive the values through the same path the session does — call
  // the right accumulator method based on the value kind.
  const feed = (message: Ably.InboundMessage): void => {
    for (const value of decoder.decode(message)) {
      if (value.messageId === undefined) continue;
      if (value.kind === 'part') {
        accumulator.processPart(value.part, value.messageId);
      } else if (value.kind === 'message') {
        accumulator.applyMessage(value.messageId, value.message);
      }
    }
  };
  return { decoder, accumulator, feed };
};

describe('UIMessageCodec decoder + accumulator', () => {
  describe('streaming text round-trip', () => {
    it('builds a single UIMessage with the concatenated text from text-start/delta/end', () => {
      const { accumulator, feed } = makeStack();

      // Real Ably appends carry persistent headers from the create — the
      // encoder core repeats them on every appendMessage. Mirror that
      // here so x-ably-msg-id correlation works for the deltas.
      const persistentHeaders = {
        [Headers.Stream]: 'true',
        [Headers.StreamId]: 'p-1',
        [Headers.MessageId]: 'wire-1',
      };
      feed(
        makeInbound({
          action: 'message.create',
          serial: '01',
          name: 'text',
          data: '',
          headers: { ...persistentHeaders, [Headers.Status]: 'streaming' },
        }),
      );
      feed(makeInbound({ action: 'message.append', serial: '01', data: 'hello', headers: persistentHeaders }));
      feed(makeInbound({ action: 'message.append', serial: '01', data: ' world', headers: persistentHeaders }));
      feed(
        makeInbound({
          action: 'message.append',
          serial: '01',
          data: '',
          headers: { ...persistentHeaders, [Headers.Status]: 'finished' },
        }),
      );

      const message = accumulator.getMessage('wire-1');
      expect(message).toBeDefined();
      expect(message?.id).toBe('wire-1');
      expect(message?.role).toBe('assistant');
      expect(message?.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    });
  });

  describe('discrete text round-trip', () => {
    it('builds a UIMessage carrying the caller-supplied id and role from x-domain-messageId / x-ably-role', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '02',
          name: 'text',
          data: 'hi',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.Discrete]: 'true',
            [Headers.MessageId]: 'wire-2',
            [Headers.Role]: 'user',
            'x-domain-messageId': 'msg-X',
          },
        }),
      );

      // The codec stamps the SDK routing id (`wire-2`) on the chunk
      // outputs; the accumulator stores the assembled message under that
      // key. The UIMessage.id is the caller-supplied one.
      const message = accumulator.getMessage('wire-2');
      expect(message).toBeDefined();
      expect(message?.id).toBe('msg-X');
      expect(message?.role).toBe('user');
      expect(message?.parts).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('appends each text wire under the same x-ably-msg-id as a distinct part', () => {
      const { accumulator, feed } = makeStack();

      // Two wires sharing one x-ably-msg-id (a multi-text-part UIMessage
      // published by encodeMessage) should yield two text parts.
      const baseHeaders = {
        [Headers.Stream]: 'false',
        [Headers.Discrete]: 'true',
        [Headers.MessageId]: 'wire-3',
        [Headers.Role]: 'user',
        'x-domain-messageId': 'msg-Y',
      };
      feed(makeInbound({ action: 'message.create', serial: '03', name: 'text', data: 'first', headers: baseHeaders }));
      feed(makeInbound({ action: 'message.create', serial: '04', name: 'text', data: 'second', headers: baseHeaders }));

      const message = accumulator.getMessage('wire-3');
      expect(message).toBeDefined();
      expect(message?.parts).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]);
      expect(message?.id).toBe('msg-Y');
    });
  });

  describe('out-of-scope wires', () => {
    it('ignores discrete wires whose name is not text', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '05',
          name: 'reasoning',
          data: '',
          headers: { [Headers.Stream]: 'false', [Headers.Discrete]: 'true', [Headers.MessageId]: 'wire-5' },
        }),
      );

      expect(accumulator.getMessage('wire-5')).toBeUndefined();
    });

    it('ignores text discrete wires that lack the x-ably-discrete marker (lifecycle echoes)', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '06',
          name: 'text',
          data: 'hi',
          headers: { [Headers.Stream]: 'false', [Headers.MessageId]: 'wire-6' },
        }),
      );

      expect(accumulator.getMessage('wire-6')).toBeUndefined();
    });

    it('ignores streamed wires whose name is not text or tool-input', () => {
      const { accumulator, feed } = makeStack();

      feed(
        makeInbound({
          action: 'message.create',
          serial: '07',
          name: 'reasoning',
          data: '',
          headers: {
            [Headers.Stream]: 'true',
            [Headers.StreamId]: 'r-1',
            [Headers.MessageId]: 'wire-7',
            [Headers.Status]: 'streaming',
          },
        }),
      );

      expect(accumulator.getMessage('wire-7')).toBeUndefined();
    });
  });

  describe('streaming tool-input round-trip', () => {
    it('builds a static tool-${toolName} part transitioning input-streaming → input-available', () => {
      const { accumulator, feed } = makeStack();
      const startHeaders = { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' };

      feed(
        makeInbound({
          action: 'message.create',
          serial: '10',
          name: 'tool-input',
          data: '',
          headers: startHeaders,
        }),
      );

      const streaming = accumulator.getMessage('tool-msg');
      expect(streaming?.parts).toHaveLength(1);
      const streamingPart = streaming?.parts[0];
      expect(streamingPart?.type).toBe('tool-getWeather');
      // CAST: discriminated-union narrowing is awkward in tests; assert
      // the runtime shape by structural access.
      expect((streamingPart as { state: string }).state).toBe('input-streaming');
      expect((streamingPart as { input: unknown }).input).toBeUndefined();

      // Deltas pass through the decoder as `tool-input-delta` chunks but
      // don't fold into the assembled state — partial JSON parsing is
      // out-of-scope.
      feed(
        makeInbound({
          action: 'message.append',
          serial: '10',
          data: '{"city":"Paris"}',
          headers: persistentToolInputHeaders(),
        }),
      );
      expect((accumulator.getMessage('tool-msg')?.parts[0] as { state: string }).state).toBe('input-streaming');

      // Closing append carries the parsed input as a domain header — the
      // decoder rebuilds a `tool-input-available` chunk and the
      // accumulator transitions the part.
      feed(
        makeInbound({
          action: 'message.append',
          serial: '10',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify({ city: 'Paris' }),
          },
        }),
      );

      const final = accumulator.getMessage('tool-msg');
      expect(final?.parts).toHaveLength(1);
      const finalPart = final?.parts[0];
      expect((finalPart as { state: string }).state).toBe('input-available');
      expect((finalPart as { input: unknown }).input).toEqual({ city: 'Paris' });
      expect((finalPart as { toolCallId: string }).toolCallId).toBe('t-1');
      expect(finalPart?.type).toBe('tool-getWeather');
    });

    it('builds a dynamic-tool part when the start chunk carries dynamic:true', () => {
      const { accumulator, feed } = makeStack();
      const headers = {
        ...persistentToolInputHeaders(),
        [Headers.Status]: 'streaming',
        'x-domain-dynamic': 'true',
        'x-domain-title': 'Custom tool',
      };

      feed(makeInbound({ action: 'message.create', serial: '11', name: 'tool-input', data: '', headers }));
      feed(
        makeInbound({
          action: 'message.append',
          serial: '11',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-dynamic': 'true',
            'x-domain-input': JSON.stringify({ q: 'hello' }),
          },
        }),
      );

      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect(part?.type).toBe('dynamic-tool');
      expect((part as { toolName: string }).toolName).toBe('getWeather');
      expect((part as { state: string }).state).toBe('input-available');
      expect((part as { input: unknown }).input).toEqual({ q: 'hello' });
    });

    it('transitions to output-error when the close carries x-domain-errorText', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '12',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.append',
          serial: '12',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify('{"city":'),
            'x-domain-errorText': 'invalid JSON',
          },
        }),
      );

      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect((part as { state: string }).state).toBe('output-error');
      expect((part as { errorText: string }).errorText).toBe('invalid JSON');
      expect((part as { rawInput: unknown }).rawInput).toBe('{"city":');
      expect((part as { input: unknown }).input).toBeUndefined();
    });

    it('drops a tool-input stream whose start has no toolName header', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '13',
          name: 'tool-input',
          data: '',
          headers: {
            [Headers.Stream]: 'true',
            [Headers.StreamId]: 't-broken',
            [Headers.MessageId]: 'tool-msg-broken',
            [Headers.Status]: 'streaming',
            // toolName intentionally missing
          },
        }),
      );

      expect(accumulator.getMessage('tool-msg-broken')).toBeUndefined();
    });

    it('drops a tool-input close whose headers lose the toolName (defensive)', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '14',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.append',
          serial: '14',
          data: '',
          headers: {
            // Persistent headers re-applied by the encoder core normally
            // include toolName; simulate a malformed close by stripping it.
            [Headers.Stream]: 'true',
            [Headers.StreamId]: 't-1',
            [Headers.MessageId]: 'tool-msg',
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify({ city: 'Paris' }),
          },
        }),
      );

      // Start built the part in `input-streaming`; the malformed close
      // emits no event, so the part stays in the streaming state.
      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect((part as { state: string }).state).toBe('input-streaming');
    });

    it('handles a tool-input append for an unknown serial as first-contact recovery (creates the part lazily)', () => {
      const { accumulator, feed } = makeStack();

      // Append before any matching create — the decoder core's recovery
      // path (`_decodeAppend` → `_decodeUpdate` → `_decodeFirstContact`)
      // treats a streamed append for an unknown serial as if it were a
      // late-observed create, so subscribers that join mid-stream still
      // see a tool part in `input-streaming` state.
      feed(
        makeInbound({
          action: 'message.append',
          serial: '16',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.MessageId]: 'tool-msg-orphan' },
        }),
      );

      const part = accumulator.getMessage('tool-msg-orphan')?.parts[0];
      expect(part?.type).toBe('tool-getWeather');
      expect((part as { state: string }).state).toBe('input-streaming');
    });

    it('transitions input-available → output-available when a tool-output-available wire arrives', () => {
      const { accumulator, feed } = makeStack();
      // Open and complete a tool input stream first.
      feed(
        makeInbound({
          action: 'message.create',
          serial: '20',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.append',
          serial: '20',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify({ city: 'Paris' }),
          },
        }),
      );

      // Now the output arrives as a discrete wire.
      feed(
        makeInbound({
          action: 'message.create',
          serial: '21',
          name: 'tool-output-available',
          data: { temperature: 22, units: 'celsius' },
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg',
            'x-domain-toolCallId': 't-1',
          },
        }),
      );

      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect((part as { state: string }).state).toBe('output-available');
      expect((part as { input: unknown }).input).toEqual({ city: 'Paris' });
      expect((part as { output: unknown }).output).toEqual({ temperature: 22, units: 'celsius' });
      // Identity preserved from the input phase.
      expect(part?.type).toBe('tool-getWeather');
      expect((part as { toolCallId: string }).toolCallId).toBe('t-1');
    });

    it('preserves resultProviderMetadata and preliminary on output-available', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '22',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.append',
          serial: '22',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify({ q: 'hello' }),
          },
        }),
      );

      feed(
        makeInbound({
          action: 'message.create',
          serial: '23',
          name: 'tool-output-available',
          data: 'partial',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg',
            'x-domain-toolCallId': 't-1',
            'x-domain-preliminary': 'true',
            'x-domain-providerMetadata': JSON.stringify({ anthropic: { cacheHit: true } }),
          },
        }),
      );

      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect((part as { preliminary: boolean }).preliminary).toBe(true);
      expect((part as { resultProviderMetadata: unknown }).resultProviderMetadata).toEqual({
        anthropic: { cacheHit: true },
      });
    });

    it('overwrites output across successive preliminary tool-output-available chunks then settles on the final', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '24a',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.append',
          serial: '24a',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify({ q: 'streaming-test' }),
          },
        }),
      );

      // First preliminary chunk — partial output.
      feed(
        makeInbound({
          action: 'message.create',
          serial: '24b',
          name: 'tool-output-available',
          data: { partial: 'first' },
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg',
            'x-domain-toolCallId': 't-1',
            'x-domain-preliminary': 'true',
          },
        }),
      );
      const afterFirst = accumulator.getMessage('tool-msg')?.parts[0];
      expect((afterFirst as { output: unknown }).output).toEqual({ partial: 'first' });
      expect((afterFirst as { preliminary: boolean }).preliminary).toBe(true);

      // Second preliminary chunk — overwrite output, still preliminary.
      feed(
        makeInbound({
          action: 'message.create',
          serial: '24c',
          name: 'tool-output-available',
          data: { partial: 'second' },
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg',
            'x-domain-toolCallId': 't-1',
            'x-domain-preliminary': 'true',
          },
        }),
      );
      const afterSecond = accumulator.getMessage('tool-msg')?.parts[0];
      expect((afterSecond as { output: unknown }).output).toEqual({ partial: 'second' });

      // Final non-preliminary chunk — settles. preliminary becomes false (not undefined: header explicitly says 'false').
      feed(
        makeInbound({
          action: 'message.create',
          serial: '24d',
          name: 'tool-output-available',
          data: { final: true, value: 42 },
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg',
            'x-domain-toolCallId': 't-1',
            'x-domain-preliminary': 'false',
          },
        }),
      );
      const final = accumulator.getMessage('tool-msg')?.parts[0];
      expect((final as { output: unknown }).output).toEqual({ final: true, value: 42 });
      expect((final as { preliminary: boolean }).preliminary).toBe(false);
      // Input preserved through every preliminary transition.
      expect((final as { input: unknown }).input).toEqual({ q: 'streaming-test' });
    });

    it('transitions to output-error when a tool-output-error wire arrives, preserving input', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '24',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.append',
          serial: '24',
          data: '',
          headers: {
            ...persistentToolInputHeaders(),
            [Headers.Status]: 'finished',
            'x-domain-input': JSON.stringify({ city: 'Paris' }),
          },
        }),
      );

      feed(
        makeInbound({
          action: 'message.create',
          serial: '25',
          name: 'tool-output-error',
          data: 'rate limited',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg',
            'x-domain-toolCallId': 't-1',
          },
        }),
      );

      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect((part as { state: string }).state).toBe('output-error');
      expect((part as { errorText: string }).errorText).toBe('rate limited');
      // input preserved across the transition; output cleared (output-error has output:never).
      expect((part as { input: unknown }).input).toEqual({ city: 'Paris' });
      expect((part as { output?: unknown }).output).toBeUndefined();
    });

    it('drops a tool-output-available wire with no toolCallId header', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '26',
          name: 'tool-input',
          data: '',
          headers: { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' },
        }),
      );
      feed(
        makeInbound({
          action: 'message.create',
          serial: '27',
          name: 'tool-output-available',
          data: 'whatever',
          // toolCallId intentionally missing
          headers: { [Headers.Stream]: 'false', [Headers.MessageId]: 'tool-msg' },
        }),
      );

      // Part stays in input-streaming — the broken output wire is dropped.
      const part = accumulator.getMessage('tool-msg')?.parts[0];
      expect((part as { state: string }).state).toBe('input-streaming');
    });

    it('drops a tool-output-available wire whose toolCallId has no matching tool part', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '28',
          name: 'tool-output-available',
          data: 'whatever',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.MessageId]: 'tool-msg-orphan-out',
            'x-domain-toolCallId': 't-orphan',
          },
        }),
      );

      // No tool-input-start preceded this output and no other path
      // created state for this messageId, so the lookup fails at the
      // first hop (no state) and the accumulator never materialises a
      // message — the wire is logged-and-dropped.
      expect(accumulator.getMessage('tool-msg-orphan-out')).toBeUndefined();
    });

    it('ignores duplicate tool-input-start chunks for the same toolCallId', () => {
      const { accumulator, feed } = makeStack();
      const startHeaders = { ...persistentToolInputHeaders(), [Headers.Status]: 'streaming' };

      feed(
        makeInbound({ action: 'message.create', serial: '15a', name: 'tool-input', data: '', headers: startHeaders }),
      );
      feed(
        makeInbound({ action: 'message.create', serial: '15b', name: 'tool-input', data: '', headers: startHeaders }),
      );

      // Two creates, but the accumulator deduplicates by toolCallId — only
      // one part is appended to the message.
      expect(accumulator.getMessage('tool-msg')?.parts).toHaveLength(1);
    });
  });

  describe('setMessage / completeMessage', () => {
    it('setMessage replaces the assembled state', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '08',
          name: 'text',
          data: 'first',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.Discrete]: 'true',
            [Headers.MessageId]: 'wire-8',
            [Headers.Role]: 'user',
            'x-domain-messageId': 'msg-A',
          },
        }),
      );

      accumulator.setMessage('wire-8', {
        id: 'msg-A',
        role: 'user',
        parts: [{ type: 'text', text: 'replacement' }],
      });

      expect(accumulator.getMessage('wire-8')?.parts).toEqual([{ type: 'text', text: 'replacement' }]);
    });

    it('completeMessage clears stream state but keeps the assembled message readable', () => {
      const { accumulator, feed } = makeStack();
      feed(
        makeInbound({
          action: 'message.create',
          serial: '09',
          name: 'text',
          data: 'hi',
          headers: {
            [Headers.Stream]: 'false',
            [Headers.Discrete]: 'true',
            [Headers.MessageId]: 'wire-9',
            [Headers.Role]: 'user',
            'x-domain-messageId': 'msg-B',
          },
        }),
      );

      accumulator.completeMessage('wire-9');

      expect(accumulator.getMessage('wire-9')?.parts).toEqual([{ type: 'text', text: 'hi' }]);
    });
  });

  describe('applyEvent', () => {
    it('throws Ably.ErrorInfo with InvalidArgument — events are deferred', () => {
      const { accumulator } = makeStack();
      // CAST: phase 8 has no real ToolModelMessage path; the throw fires before reading the value.
      expect(() => {
        accumulator.applyEvent({} as never, 'wire-Z');
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });
});
