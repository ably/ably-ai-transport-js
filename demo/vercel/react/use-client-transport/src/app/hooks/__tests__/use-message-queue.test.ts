import { act, renderHook } from '@testing-library/react';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ClientTransport } from '@ably/ably-ai-transport-js';
import { describe, expect, it, vi } from 'vitest';

import { useMessageQueue } from '../use-message-queue';

const createMockTransport = () =>
  ({
    waitForTurn: vi.fn(() => Promise.resolve()),
  }) as unknown as ClientTransport<UIMessageChunk, UIMessage>;

const createMockSend = () =>
  vi.fn(() => Promise.resolve({ stream: new ReadableStream(), turnId: 'turn-1', cancel: vi.fn() }));

describe('useMessageQueue', () => {
  it('starts with an empty queue', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useMessageQueue(transport, send));

    expect(result.current.items).toEqual([]);
  });

  it('add() appends an item to the queue', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useMessageQueue(transport, send));

    act(() => {
      result.current.add('hello');
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'hello' })]));
  });

  it('remove() removes an item by id', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useMessageQueue(transport, send));

    act(() => {
      result.current.add('first');
      result.current.add('second');
    });

    const [first] = result.current.items;
    expect(first).toBeDefined();

    act(() => {
      result.current.remove(first?.id ?? '');
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'second' })]));
  });

  it('clear() removes all items', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useMessageQueue(transport, send));

    act(() => {
      result.current.add('one');
      result.current.add('two');
    });

    expect(result.current.items).toHaveLength(2);

    act(() => {
      result.current.clear();
    });

    expect(result.current.items).toEqual([]);
  });

  it('drain sends queued messages after waitForTurn resolves', async () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useMessageQueue(transport, send));

    act(() => {
      result.current.add('queued message');
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(transport.waitForTurn).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ parts: [{ type: 'text', text: 'queued message' }] })]),
    );
    expect(result.current.items).toEqual([]);
  });

  it('drain batches multiple queued messages', async () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useMessageQueue(transport, send));

    act(() => {
      result.current.add('first');
      result.current.add('second');
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ parts: [{ type: 'text', text: 'first' }] }),
        expect.objectContaining({ parts: [{ type: 'text', text: 'second' }] }),
      ]),
    );
  });
});
