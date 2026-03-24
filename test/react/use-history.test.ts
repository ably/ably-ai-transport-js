// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useHistory } from '../../src/react/use-history.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useHistory', () => {
  it('starts with hasNext=false and loading=false', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useHistory(transport));

    expect(result.current.hasNext).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('load() fetches the first page and sets hasNext', async () => {
    const mock = createMockTransport();
    mock.history.mockResolvedValue({
      items: ['msg-1'],
      hasNext: () => true,
      // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock returns undefined page
      next: () => Promise.resolve(undefined),
    });

    const { result } = renderHook(() => useHistory(mock.transport));

    await act(async () => {
      await result.current.load({ limit: 10 });
    });

    expect(mock.history).toHaveBeenCalledWith({ limit: 10 });
    expect(result.current.hasNext).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('next() fetches the next page', async () => {
    const mock = createMockTransport();
    const secondPage = {
      items: ['msg-2'],
      hasNext: () => false,
      // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock returns undefined page
      next: () => Promise.resolve(undefined),
    };

    mock.history.mockResolvedValue({
      items: ['msg-1'],
      hasNext: () => true,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      next: () => Promise.resolve(secondPage),
    });

    const { result } = renderHook(() => useHistory(mock.transport));

    await act(async () => {
      await result.current.load();
    });

    expect(result.current.hasNext).toBe(true);

    await act(async () => {
      await result.current.next();
    });

    expect(result.current.hasNext).toBe(false);
  });

  it('auto-loads on mount when options are provided', async () => {
    const mock = createMockTransport();
    mock.history.mockResolvedValue({
      items: [],
      hasNext: () => false,
      // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock returns undefined page
      next: () => Promise.resolve(undefined),
    });

    renderHook(() => useHistory(mock.transport, { limit: 5 }));

    // Wait for the auto-load to complete
    await act(async () => {
      // Flush microtasks so the async load() resolves
      await Promise.resolve();
    });

    expect(mock.history).toHaveBeenCalledWith({ limit: 5 });
  });

  it('does not auto-load when options are omitted', () => {
    const mock = createMockTransport();

    renderHook(() => useHistory(mock.transport));

    expect(mock.history).not.toHaveBeenCalled();
  });

  it('next() is no-op when no page loaded', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useHistory(mock.transport));

    await act(async () => {
      await result.current.next();
    });

    expect(mock.history).not.toHaveBeenCalled();
  });

  it('does not load when transport is undefined', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly testing undefined transport
    const { result } = renderHook(() => useHistory(undefined));

    await act(async () => {
      await result.current.load();
    });

    // No crash, no-op
    expect(result.current.loading).toBe(false);
  });
});
