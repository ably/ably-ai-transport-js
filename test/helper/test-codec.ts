/**
 * A small codec for transport tests: one streamed type, a discrete type, a
 * type that publishes nothing, and one that replaces a stream's content. It
 * belongs to no provider, so what a test asserts is the transport's behaviour
 * and nothing else.
 */

import type { Codec } from '../../src/core/codec/index.js';
import { defineCodec } from '../../src/core/codec/index.js';

/** The test codec's events. */
export type TestEvent =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'text-replace'; id: string; text: string }
  | { type: 'note'; text: string }
  | { type: 'ping' };

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const idOf = (headers: Record<string, unknown> = {}): string => asString(headers.id);

/**
 * Build a fresh test codec. Fresh, because a built codec's decoder core
 * remembers every serial it has seen.
 * @returns The codec.
 */
export const createTestCodec = (): Codec<TestEvent> =>
  defineCodec({
    name: 'test',
    adapterTag: 'test-codec',
    typeOf: (e: TestEvent) => e.type,
    events: {
      'text-start': {
        encode: (e) => ({ headers: { id: e.id } }),
        decode: ({ headers }) => ({ type: 'text-start', id: idOf(headers) }),
      },
      'text-delta': {
        // The first delta of a stream publishes the message the rest append to.
        encode: (e) => ({ data: e.delta, headers: { id: e.id }, append: e.id }),
        decode: ({ data, headers }) => ({ type: 'text-delta', id: idOf(headers), delta: asString(data) }),
      },
      'text-end': {
        encode: (e) => ({ headers: { id: e.id }, ends: e.id }),
        decode: ({ headers }) => ({ type: 'text-end', id: idOf(headers) }),
      },
      'text-replace': {
        encode: (e) => ({ data: e.text, headers: { id: e.id }, update: e.id }),
        decode: ({ data, headers }) => ({ type: 'text-replace', id: idOf(headers), text: asString(data) }),
      },
      note: {
        encode: (e) => ({ data: e.text }),
        decode: ({ data }) => ({ type: 'note', text: asString(data) }),
      },
      ping: {
        // eslint-disable-next-line unicorn/no-useless-undefined -- a row that publishes nothing returns undefined
        encode: () => undefined,
        decode: () => ({ type: 'ping' }),
      },
    },
  });

/**
 * The events of one streamed text: a start, one delta per fragment, an end.
 * @param id - The stream's id.
 * @param deltas - The fragments.
 * @returns The events in order.
 */
export const textEvents = (id: string, ...deltas: string[]): TestEvent[] => [
  { type: 'text-start', id },
  ...deltas.map((delta): TestEvent => ({ type: 'text-delta', id, delta })),
  { type: 'text-end', id },
];

/**
 * A ReadableStream that emits `events` then closes.
 * @param events - The events to emit.
 * @returns The stream.
 */
export const streamOf = <E>(...events: E[]): ReadableStream<E> =>
  new ReadableStream({
    start: (controller) => {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });

/**
 * An async iterable of `events` that records whether the pipe released it
 * early through `return()`.
 * @param events - The events to yield.
 * @returns The iterable and a flag flipped by `return()`.
 */
export const asyncIterableOf = <E>(...events: E[]): { iterable: AsyncIterable<E>; state: { returned: boolean } } => {
  const state = { returned: false };
  const iterable: AsyncIterable<E> = {
    [Symbol.asyncIterator]: () => {
      const remaining = [...events];
      return {
        // eslint-disable-next-line @typescript-eslint/require-await -- fixture iterator
        next: async () => {
          const value = remaining.shift();
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- fixture iterator
        return: async () => {
          state.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, state };
};

/**
 * A ReadableStream that never delivers, so a pipe over it only ends by signal.
 * @returns The stream.
 */
export const neverEndingStream = <E>(): ReadableStream<E> => new ReadableStream<E>();

/**
 * A promise that never settles.
 * @returns The promise.
 */
export const neverSettles = async <T>(): Promise<T> =>
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- never-settling by design
  new Promise<T>(() => {});

/**
 * An async iterable that yields `events` then throws `error` from the next pull.
 * @param events - The events to yield first.
 * @param error - The error to throw once they are exhausted.
 * @returns The iterable.
 */
export const erroringIterableOf = <E>(events: E[], error: Error): AsyncIterable<E> => ({
  [Symbol.asyncIterator]: () => {
    const remaining = [...events];
    return {
      // eslint-disable-next-line @typescript-eslint/require-await -- fixture iterator
      next: async () => {
        const value = remaining.shift();
        if (value === undefined) throw error;
        return { done: false, value };
      },
    };
  },
});
