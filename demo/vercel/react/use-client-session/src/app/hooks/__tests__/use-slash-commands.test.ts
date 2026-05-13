import { act, renderHook } from '@testing-library/react';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ClientSession } from '@ably/ai-transport';
import { describe, expect, it, vi } from 'vitest';

import { useSlashCommands } from '../use-slash-commands';

const createMockSession = () =>
  ({
    cancel: vi.fn(() => Promise.resolve()),
  }) as unknown as ClientSession<UIMessageChunk, UIMessage>;

const createMockSend = () =>
  vi.fn(() =>
    Promise.resolve({
      stream: new ReadableStream(),
      runId: 'run-1',
      invocationId: 'inv-1',
      cancel: vi.fn(),
      optimisticMsgIds: [],
    }),
  );

describe('useSlashCommands', () => {
  it('is inactive when input does not start with /', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, 'hello'));

    expect(result.current.isActive).toBe(false);
    expect(result.current.suggestions).toEqual([]);
  });

  it('is active and shows suggestions when input starts with /', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/'));

    expect(result.current.isActive).toBe(true);
    expect(result.current.suggestions.length).toBeGreaterThan(0);
  });

  it('filters suggestions by prefix', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/bt'));

    expect(result.current.suggestions).toHaveLength(1);
    expect(result.current.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ name: '/btw' })]));
  });

  it('canExecute is true for /cancel', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/cancel'));

    expect(result.current.canExecute).toBe(true);
  });

  it('canExecute is true for /cancel all', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/cancel all'));

    expect(result.current.canExecute).toBe(true);
  });

  it('canExecute is true for /interrupt with argument', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/interrupt hello'));

    expect(result.current.canExecute).toBe(true);
  });

  it('canExecute is false for /interrupt without argument', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/interrupt'));

    expect(result.current.canExecute).toBe(false);
  });

  it('canExecute is true for /btw with argument', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/btw hey'));

    expect(result.current.canExecute).toBe(true);
  });

  it('execute /cancel calls session.cancel with own: true', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/cancel'));

    const executed = result.current.execute('/cancel');
    expect(executed).toBe(true);
    expect(session.cancel).toHaveBeenCalledWith({ own: true });
  });

  it('execute /cancel all calls session.cancel with all: true', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/cancel all'));

    const executed = result.current.execute('/cancel all');
    expect(executed).toBe(true);
    expect(session.cancel).toHaveBeenCalledWith({ all: true });
  });

  it('execute /cancel <runId> calls session.cancel with runId', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/cancel abc123'));

    const executed = result.current.execute('/cancel abc123');
    expect(executed).toBe(true);
    expect(session.cancel).toHaveBeenCalledWith({ runId: 'abc123' });
  });

  it('execute /btw sends message immediately', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/btw hello'));

    const executed = result.current.execute('/btw hello');
    expect(executed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ parts: [{ type: 'text', text: 'hello' }] })]),
    );
  });

  it('execute /interrupt cancels then sends', async () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/interrupt new prompt'));

    const executed = result.current.execute('/interrupt new prompt');
    expect(executed).toBe(true);
    expect(session.cancel).toHaveBeenCalledWith({ own: true });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ parts: [{ type: 'text', text: 'new prompt' }] })]),
    );
  });

  it('execute returns false for unrecognized commands', () => {
    const session = createMockSession();
    const send = createMockSend();

    const { result } = renderHook(() => useSlashCommands(session, new Map(), send, '/unknown'));

    const executed = result.current.execute('/unknown');
    expect(executed).toBe(false);
  });

  it('shows active run IDs in suggestions', () => {
    const session = createMockSession();
    const send = createMockSend();
    const activeRuns = new Map([['user-1', new Set(['run-abc'])]]);

    const { result } = renderHook(() => useSlashCommands(session, activeRuns, send, '/'));

    const runSuggestion = result.current.suggestions.find((s) => s.name === '/cancel run-abc');
    expect(runSuggestion).toBeDefined();
    expect(runSuggestion?.description).toBe('Cancel run from user-1');
  });
});
