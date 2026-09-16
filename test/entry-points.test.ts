/**
 * Guards what the public entry point publishes.
 *
 * Each entry point's `index.ts` is the authoritative list of its public API.
 * The module suites import internal files directly and never exercise the
 * barrel, so an export that goes missing would surface only in a consumer's
 * build.
 *
 * The type-level assertions are checked by `pnpm run typecheck` (which
 * includes `test/`): each names a public type on a local, so dropping a type
 * export fails the typecheck. The runtime assertions keep the cases live under
 * `pnpm test`.
 *
 * The codec assertion is an exact key set rather than a deny-list. A codec
 * exposes encode, decode and its adapter tag and nothing else; anything more
 * means message assembly moved back inside the SDK, which is the boundary this
 * design exists to hold.
 *
 * These import the source barrel, not the package specifier, so they run
 * without a build. They therefore do not guard the `exports` map itself; that
 * is `pnpm run build`'s job, which fails if a declared subpath has no bundle.
 */

import type * as Ably from 'ably';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ChannelWriter,
  Codec,
  DecodedRow,
  DecoderCore,
  DecoderCoreOptions,
  DefineCodecConfig,
  Delivery,
  EncodedMessage,
  EncodedRow,
  EventRow,
  EventRows,
  HeaderPrimitive,
  HistoryOptions,
  HistoryPage,
  LogContext,
  Logger,
  LoggerOptions,
  LogHandler,
  PipeOptions,
  PipeResult,
  PipeSource,
  RowEvent,
  RowEventType,
  RowMessage,
  SendResult,
  Stripped,
  Transport,
  TransportOptions,
} from '../src/index.js';
import {
  channelAgent,
  consoleLogger,
  createDecoderCore,
  createTransport,
  defineCodec,
  ErrorCode,
  errorInfoIs,
  EventEmitter,
  LogLevel,
  makeLogger,
  OBJECT_MODES,
  resolveChannelModes,
  stripUndefined,
} from '../src/index.js';
import type { OpenAIEvent, OpenAIInput, OpenAIStreamEvent } from '../src/openai/index.js';
import { createOpenAICodec, openai } from '../src/openai/index.js';
import type { VercelCrossMajorChunk, VercelEvent, VercelUserMessage } from '../src/vercel/index.js';
import { createVercelCodec, vercel } from '../src/vercel/index.js';
import { createTestCodec, type TestEvent } from './helper/test-codec.js';

/** The only keys a built codec may carry. */
const CODEC_KEYS = ['adapterTag', 'decode', 'encode'];

describe('@ably/ai-transport', () => {
  it('exports the transport factory and channel resolution helpers', () => {
    expect(typeof createTransport).toBe('function');
    expect(typeof channelAgent).toBe('function');
    expect(typeof resolveChannelModes).toBe('function');
    expect(Array.isArray(OBJECT_MODES)).toBe(true);
  });

  it('exports the codec builder and decoder core', () => {
    expect(typeof defineCodec).toBe('function');
    expect(typeof createDecoderCore).toBe('function');
  });

  it('builds a codec that carries encode, decode and its adapter tag and nothing else', () => {
    const codec = createTestCodec();
    expect(Object.keys(codec).toSorted()).toEqual(CODEC_KEYS);
  });

  it('exports the utilities, emitter, errors and logger', () => {
    expect(typeof stripUndefined).toBe('function');
    expect(typeof EventEmitter).toBe('function');
    expect(typeof ErrorCode.InvalidArgument).toBe('number');
    expect(typeof errorInfoIs).toBe('function');
    expect(typeof makeLogger).toBe('function');
    expect(typeof consoleLogger).toBe('function');
    expect(LogLevel.Silent).toBeDefined();
  });

  it('exports the public types', () => {
    expectTypeOf<Transport<TestEvent>>().toHaveProperty('pipe');
    expectTypeOf<TransportOptions<TestEvent>>().toHaveProperty('codec');
    expectTypeOf<SendResult>().toHaveProperty('serial');
    expectTypeOf<PipeOptions>().toHaveProperty('signal');
    expectTypeOf<PipeResult>().toHaveProperty('serial');
    expectTypeOf<PipeSource<TestEvent>>().not.toBeNever();
    expectTypeOf<Transport<TestEvent>['subscribe']>().returns.toEqualTypeOf<() => void>();
    expectTypeOf<HistoryOptions>().toHaveProperty('limit');
    expectTypeOf<HistoryPage<TestEvent>>().toHaveProperty('next');
    expectTypeOf<ChannelWriter>().toHaveProperty('appendMessage');
    expectTypeOf<Codec<TestEvent>>().toHaveProperty('decode');
    expectTypeOf<Codec<TestEvent>['encode']>().returns.toEqualTypeOf<EncodedMessage[]>();
    expectTypeOf<Codec<TestEvent>['decode']>().returns.toEqualTypeOf<TestEvent[]>();
    expectTypeOf<EncodedMessage>().toHaveProperty('message');
    expectTypeOf<Delivery<TestEvent>>().toHaveProperty('message');
    expectTypeOf<DecoderCore>().toHaveProperty('prepare');
    expectTypeOf<DecoderCoreOptions>().toHaveProperty('logger');
    expectTypeOf<DefineCodecConfig<TestEvent, TestEvent['type']>>().toHaveProperty('events');
    expectTypeOf<EventRows<TestEvent, TestEvent['type']>>().toHaveProperty('note');
    expectTypeOf<EventRow<TestEvent, 'note'>>().toHaveProperty('encode');
    expectTypeOf<RowEvent<TestEvent, 'note'>>().toEqualTypeOf<{ type: 'note'; text: string }>();
    expectTypeOf<RowEventType<'data-*'>>().toEqualTypeOf<`data-${string}`>();
    expectTypeOf<RowMessage>().toHaveProperty('fields');
    expectTypeOf<RowMessage>().toHaveProperty('headers');
    expectTypeOf<HeaderPrimitive>().toEqualTypeOf<string | number | boolean | null>();
    expectTypeOf<EncodedRow>().toHaveProperty('publish');
    expectTypeOf<DecodedRow>().toHaveProperty('type');
    expectTypeOf<Stripped<{ a: string | undefined }>>().not.toBeNever();
    expectTypeOf<Logger>().toHaveProperty('withContext');
    expectTypeOf<LoggerOptions>().toHaveProperty('logLevel');
    expectTypeOf<LogHandler>().toBeFunction();
    expectTypeOf<LogContext>().not.toBeNever();
    expectTypeOf<Ably.ErrorInfo>().toHaveProperty('code');
  });
});

describe('@ably/ai-transport/vercel', () => {
  it('exports the codec, its factory and its event types', () => {
    expect(typeof createVercelCodec).toBe('function');
    expect(Object.keys(vercel).toSorted()).toEqual(CODEC_KEYS);
    expectTypeOf<VercelEvent>().toHaveProperty('type');
    expectTypeOf<VercelUserMessage>().toHaveProperty('message');
    expectTypeOf<VercelCrossMajorChunk>().toHaveProperty('type');
  });
});

describe('@ably/ai-transport/openai', () => {
  it('exports the codec, its factory and its event types', () => {
    expect(typeof createOpenAICodec).toBe('function');
    expect(Object.keys(openai).toSorted()).toEqual(CODEC_KEYS);
    expectTypeOf<OpenAIEvent>().toHaveProperty('type');
    expectTypeOf<OpenAIInput>().toHaveProperty('items');
    expectTypeOf<OpenAIStreamEvent>().toHaveProperty('type');
  });
});
