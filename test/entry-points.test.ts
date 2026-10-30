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
 * exposes encode, decode, its id and its name and nothing else; anything more
 * means message assembly moved back inside the SDK, which is the boundary this
 * design exists to hold.
 *
 * These import the source barrel, not the package specifier, so they run
 * without a build. They therefore do not guard the `exports` map itself; that
 * is `pnpm run build`'s job, which fails if a declared subpath has no bundle.
 */

import type * as Ably from 'ably';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AGUIEvent, AGUIRunInput } from '../src/ag-ui/index.js';
import { agUiAdaptor, agUiDecoder } from '../src/ag-ui/index.js';
import type {
  AgentAdaptor,
  AgentAdaptorOptions,
  ChannelWriter,
  Codec,
  DecodedRow,
  Decoder,
  DecoderOptions,
  DefineCodecConfig,
  Delivery,
  EncodedMessage,
  EncodedRow,
  EventRow,
  EventRows,
  HeaderPrimitive,
  LogContext,
  Logger,
  LoggerOptions,
  LogHandler,
  MessageHeaders,
  PipeOptions,
  PipeResult,
  PipeSource,
  Published,
  RowEvent,
  RowEventType,
  RowMessage,
  SendOptions,
  SendResult,
  Stripped,
} from '../src/index.js';
import {
  consoleLogger,
  createAgentAdaptor,
  createDecoder,
  defineCodec,
  ErrorCode,
  errorInfoIs,
  EventEmitter,
  LogLevel,
  makeLogger,
  stripUndefined,
} from '../src/index.js';
import type { OpenAIEvent, OpenAIInput, OpenAIStreamEvent } from '../src/openai/index.js';
import { openaiAdaptor, openaiDecoder } from '../src/openai/index.js';
import type { VercelCrossMajorChunk, VercelEvent, VercelUserMessage } from '../src/vercel/index.js';
import { vercelAdaptor, vercelDecoder } from '../src/vercel/index.js';
import { createMockChannel } from './helper/mock-channel.js';
import { createTestCodec, type TestEvent } from './helper/test-codec.js';

/** The only keys a built codec may carry. */
const CODEC_KEYS = ['decode', 'encode', 'id', 'name'];

describe('@ably/ai-transport', () => {
  it('exports the agent adaptor factory', () => {
    expect(typeof createAgentAdaptor).toBe('function');
    expectTypeOf<AgentAdaptor<TestEvent>>().toHaveProperty('pipeEach');
    expectTypeOf<AgentAdaptorOptions>().toHaveProperty('headers');
    expectTypeOf<Published<TestEvent>>().toHaveProperty('serial');
  });

  it('exports the codec builder and the decoder', () => {
    expect(typeof defineCodec).toBe('function');
    expect(typeof createDecoder).toBe('function');
  });

  it('builds a codec that carries encode, decode, its id and its name and nothing else', () => {
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
    expectTypeOf<SendResult>().toHaveProperty('serial');
    expectTypeOf<SendOptions>().toHaveProperty('headers');
    expectTypeOf<MessageHeaders>().not.toBeNever();
    expectTypeOf<PipeOptions>().toHaveProperty('signal');
    expectTypeOf<PipeResult>().toHaveProperty('serial');
    expectTypeOf<PipeSource<TestEvent>>().not.toBeNever();
    expectTypeOf<ChannelWriter>().toHaveProperty('appendMessage');
    expectTypeOf<Codec<TestEvent>>().toHaveProperty('decode');
    expectTypeOf<Codec<TestEvent>['encode']>().returns.toEqualTypeOf<EncodedMessage[]>();
    expectTypeOf<Codec<TestEvent>['decode']>().returns.toEqualTypeOf<TestEvent[]>();
    expectTypeOf<EncodedMessage>().toHaveProperty('message');
    expectTypeOf<Delivery<TestEvent>>().toHaveProperty('message');
    expectTypeOf<Decoder<TestEvent>>().toHaveProperty('receive');
    expectTypeOf<Decoder<TestEvent>['decode']>().returns.toEqualTypeOf<Delivery<TestEvent>[]>();
    expectTypeOf<DecoderOptions>().toHaveProperty('logger');
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
  it('exports an agent adaptor factory', () => {
    const adaptor = vercelAdaptor(createMockChannel());
    expect(typeof adaptor.send).toBe('function');
    expect(typeof adaptor.pipe).toBe('function');
    expect(typeof adaptor.pipeEach).toBe('function');
  });

  it('exports a decoder factory', () => {
    expect(typeof vercelDecoder().receive).toBe('function');
    expect(typeof vercelDecoder().decode).toBe('function');
  });

  it('exports its event types', () => {
    expectTypeOf<VercelEvent>().toHaveProperty('type');
    expectTypeOf<VercelUserMessage>().toHaveProperty('message');
    expectTypeOf<VercelCrossMajorChunk>().toHaveProperty('type');
  });
});

describe('@ably/ai-transport/openai', () => {
  it('exports an agent adaptor factory', () => {
    const adaptor = openaiAdaptor(createMockChannel());
    expect(typeof adaptor.send).toBe('function');
    expect(typeof adaptor.pipe).toBe('function');
    expect(typeof adaptor.pipeEach).toBe('function');
  });

  it('exports a decoder factory', () => {
    expect(typeof openaiDecoder().receive).toBe('function');
    expect(typeof openaiDecoder().decode).toBe('function');
  });

  it('exports its event types', () => {
    expectTypeOf<OpenAIEvent>().toHaveProperty('type');
    expectTypeOf<OpenAIInput>().toHaveProperty('items');
    expectTypeOf<OpenAIStreamEvent>().toHaveProperty('type');
  });
});

describe('@ably/ai-transport/ag-ui', () => {
  it('exports an agent adaptor factory', () => {
    const adaptor = agUiAdaptor(createMockChannel());
    expect(typeof adaptor.send).toBe('function');
    expect(typeof adaptor.pipe).toBe('function');
    expect(typeof adaptor.pipeEach).toBe('function');
  });

  it('exports a decoder factory', () => {
    expect(typeof agUiDecoder().receive).toBe('function');
    expect(typeof agUiDecoder().decode).toBe('function');
  });

  it('exports its event types', () => {
    expectTypeOf<AGUIEvent>().toHaveProperty('type');
    expectTypeOf<AGUIRunInput>().toHaveProperty('input');
  });
});
