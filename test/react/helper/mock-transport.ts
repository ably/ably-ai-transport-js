/**
 * Shared mock ClientTransport for React hook tests.
 */

import { vi } from 'vitest';

import type { ClientTransport, Tree, TurnLifecycleEvent } from '../../../src/core/transport/types.js';

type EventType = 'message' | 'ably-message' | 'turn' | 'error';
type Handler = ((...args: never[]) => void) | (() => void);

export interface MockTransport {
  transport: ClientTransport<unknown, string>;
  getMessages: ReturnType<typeof vi.fn>;
  getAblyMessages: ReturnType<typeof vi.fn>;
  getActiveTurnIds: ReturnType<typeof vi.fn>;
  getTree: ReturnType<typeof vi.fn>;
  getNodes: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  waitForTurn: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Fire an event to all registered handlers. */
  emit: (event: EventType, ...args: unknown[]) => void;
  tree: Tree<string>;
}

export const createMockTransport = (initialMessages: string[] = []): MockTransport => {
  const handlers = new Map<string, Set<Handler>>();

  const emit = (event: EventType, ...args: unknown[]): void => {
    const set = handlers.get(event);
    if (set) {
      for (const handler of set) {
        (handler as (...a: unknown[]) => void)(...args);
      }
    }
  };

  const on = vi.fn((event: string, handler: Handler) => {
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

  const tree: Tree<string> = {
    flattenNodes: vi.fn(() => initialMessages.map((m, i) => ({
      message: m,
      msgId: `msg-${String(i)}`,
      parentId: undefined,
      forkOf: undefined,
      headers: {},
      serial: undefined,
    }))),
    getSiblings: vi.fn((msgId: string) => [msgId]),
    hasSiblings: vi.fn(() => false),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    getActiveTurnIds: vi.fn(() => new Map<string, Set<string>>()),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const getMessages = vi.fn(() => initialMessages);
  const getAblyMessages = vi.fn(() => []);
  const getActiveTurnIds = vi.fn(() => new Map<string, Set<string>>());
  const getTree = vi.fn(() => tree);
  const getNodes = vi.fn(() => tree.flattenNodes());

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
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const history = vi.fn(() => Promise.resolve({
    items: [] as string[],
    hasNext: () => false,
    // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock returns undefined page
    next: () => Promise.resolve(undefined),
  }));

  const transport = {
    send,
    regenerate,
    edit,
    getTree,
    cancel,
    waitForTurn,
    on,
    getAblyMessages,
    getActiveTurnIds,
    getMessages,
    getNodes,
    history,
    close,
  // CAST: mock object satisfies the subset of ClientTransport methods used by hooks
  } as unknown as ClientTransport<unknown, string>;

  return {
    transport,
    getMessages,
    getAblyMessages,
    getActiveTurnIds,
    getTree,
    getNodes,
    send,
    regenerate,
    edit,
    cancel,
    waitForTurn,
    close,
    history,
    on,
    emit,
    tree,
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
