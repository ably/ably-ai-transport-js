import { act, renderHook } from '@testing-library/react';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ClientTransport } from '@ably/ai-transport';
import { describe, expect, it, vi } from 'vitest';

import { useSlashCommands } from '../use-slash-commands';

const createMockTransport = () =>
  ({
    cancel: vi.fn(() => Promise.resolve()),
  }) as unknown as ClientTransport<UIMessageChunk, UIMessage>;

const createMockSend = () =>
  vi.fn(() => Promise.resolve({ stream: new ReadableStream(), turnId: 'turn-1', cancel: vi.fn() }));

describe('useSlashCommands', () => {
  it('is inactive when input does not start with /', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, 'hello'));

    expect(result.current.isActive).toBe(false);
    expect(result.current.suggestions).toEqual([]);
  });

  it('is active and shows suggestions when input starts with /', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/'));

    expect(result.current.isActive).toBe(true);
    expect(result.current.suggestions.length).toBeGreaterThan(0);
  });

  it('filters suggestions by prefix', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/bt'));

    expect(result.current.suggestions).toHaveLength(1);
    expect(result.current.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ name: '/btw' })]));
  });

  it('canExecute is true for /cancel', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/cancel'));

    expect(result.current.canExecute).toBe(true);
  });

  it('canExecute is true for /cancel all', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/cancel all'));

    expect(result.current.canExecute).toBe(true);
  });

  it('canExecute is true for /interrupt with argument', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/interrupt hello'));

    expect(result.current.canExecute).toBe(true);
  });

  it('canExecute is false for /interrupt without argument', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/interrupt'));

    expect(result.current.canExecute).toBe(false);
  });

  it('canExecute is true for /btw with argument', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/btw hey'));

    expect(result.current.canExecute).toBe(true);
  });

  it('execute /cancel calls transport.cancel with own: true', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/cancel'));

    const executed = result.current.execute('/cancel');
    expect(executed).toBe(true);
    expect(transport.cancel).toHaveBeenCalledWith({ own: true });
  });

  it('execute /cancel all calls transport.cancel with all: true', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/cancel all'));

    const executed = result.current.execute('/cancel all');
    expect(executed).toBe(true);
    expect(transport.cancel).toHaveBeenCalledWith({ all: true });
  });

  it('execute /cancel <turnId> calls transport.cancel with turnId', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/cancel abc123'));

    const executed = result.current.execute('/cancel abc123');
    expect(executed).toBe(true);
    expect(transport.cancel).toHaveBeenCalledWith({ turnId: 'abc123' });
  });

  it('execute /btw sends message immediately', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/btw hello'));

    const executed = result.current.execute('/btw hello');
    expect(executed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ parts: [{ type: 'text', text: 'hello' }] })]),
    );
  });

  it('execute /interrupt cancels then sends', async () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/interrupt new prompt'));

    const executed = result.current.execute('/interrupt new prompt');
    expect(executed).toBe(true);
    expect(transport.cancel).toHaveBeenCalledWith({ own: true });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ parts: [{ type: 'text', text: 'new prompt' }] })]),
    );
  });

  it('execute returns false for unrecognized commands', () => {
    const transport = createMockTransport();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(transport, new Map(), send, '/unknown'));

    const executed = result.current.execute('/unknown');
    expect(executed).toBe(false);
  });

  it('shows active turn IDs in suggestions', () => {
    const transport = createMockTransport();
    const send = createMockSend();
    const activeTurns = new Map([['user-1', new Set(['turn-abc'])]]);

    const { result } = renderHook(() => useSlashCommands(transport, activeTurns, send, '/'));

    const turnSuggestion = result.current.suggestions.find((s) => s.name === '/cancel turn-abc');
    expect(turnSuggestion).toBeDefined();
    expect(turnSuggestion?.description).toBe('Cancel turn from user-1');
  });
});
