/**
 * Shared mock ClientTransport for React hook tests.
 */

import { vi } from 'vitest';

import type { ClientTransport, Tree, TurnLifecycleEvent, View } from '../../../src/core/transport/types.js';

type TreeEventType = 'update' | 'ably-message' | 'turn';
type TransportEventType = 'error';
type Handler = ((...args: never[]) => void) | (() => void);

export interface MockTransport {
  transport: ClientTransport<unknown, string>;
  send: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  waitForTurn: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Fire an event on the transport (only 'error'). */
  emit: (event: TransportEventType, ...args: unknown[]) => void;
  /** Fire an event on tree/view (update, ably-message, turn). */
  emitTree: (event: TreeEventType, ...args: unknown[]) => void;
  tree: Tree<string>;
  view: View<string>;
}

export const createMockTransport = (initialMessages: string[] = []): MockTransport => {
  const transportHandlers = new Map<string, Set<Handler>>();
  const treeHandlers = new Map<string, Set<Handler>>();
  const viewHandlers = new Map<string, Set<Handler>>();

  const emit = (event: TransportEventType, ...args: unknown[]): void => {
    const set = transportHandlers.get(event);
    if (set) {
      for (const handler of set) {
        (handler as (...a: unknown[]) => void)(...args);
      }
    }
  };

  const emitTree = (event: TreeEventType, ...args: unknown[]): void => {
    for (const handlers of [treeHandlers, viewHandlers]) {
      const set = handlers.get(event);
      if (set) {
        for (const handler of set) {
          (handler as (...a: unknown[]) => void)(...args);
        }
      }
    }
  };

  const on = vi.fn((event: string, handler: Handler) => {
    let set = transportHandlers.get(event);
    if (!set) {
      set = new Set();
      transportHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  });

  const makeTreeOn = (handlers: Map<string, Set<Handler>>) =>
    vi.fn((event: string, handler: Handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    });

  const initialNodes = initialMessages.map((m, i) => ({
    message: m,
    msgId: `msg-${String(i)}`,
    parentId: undefined,
    forkOf: undefined,
    headers: {},
    serial: undefined,
  }));

  const tree: Tree<string> = {
    flattenNodes: vi.fn(() => initialNodes),
    getSiblings: vi.fn((msgId: string) => [msgId]),
    hasSiblings: vi.fn(() => false),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    getActiveTurnIds: vi.fn(() => new Map<string, Set<string>>()),
    on: makeTreeOn(treeHandlers),
  };

  const view: View<string> = {
    flattenNodes: vi.fn(() => initialNodes),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    getActiveTurnIds: vi.fn(() => new Map<string, Set<string>>()),
    on: makeTreeOn(viewHandlers),
  };

  const mockTurn = {
    stream: new ReadableStream(),
    turnId: 'turn-1',
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockTurn));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const regenerate = vi.fn(() => Promise.resolve(mockTurn));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const edit = vi.fn(() => Promise.resolve(mockTurn));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const cancel = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const waitForTurn = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const close = vi.fn(() => Promise.resolve());

  const transport = {
    tree,
    view,
    send,
    regenerate,
    edit,
    cancel,
    waitForTurn,
    on,
    close,
  // CAST: mock object satisfies the subset of ClientTransport methods used by hooks
  } as unknown as ClientTransport<unknown, string>;

  return {
    transport,
    send,
    regenerate,
    edit,
    cancel,
    waitForTurn,
    close,
    on,
    emit,
    emitTree,
    tree,
    view,
  };
};

/**
 * Create a mock TurnLifecycleEvent.
 * @param type - The event type ('x-ably-turn-start' or 'x-ably-turn-end').
 * @param turnId - The turn identifier.
 * @param clientId - The client identifier.
 * @param reason - The end reason (only for turn-end events).
 * @returns A TurnLifecycleEvent.
 */
export const makeTurnEvent = (
  type: 'x-ably-turn-start' | 'x-ably-turn-end',
  turnId: string,
  clientId: string,
  reason?: 'complete' | 'cancelled' | 'error',
): TurnLifecycleEvent => {
  if (type === 'x-ably-turn-start') {
    return { type, turnId, clientId };
  }
  return { type, turnId, clientId, reason: reason ?? 'complete' };
};
