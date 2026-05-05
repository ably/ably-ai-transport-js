/**
 * Shared mock ClientSession for React hook tests.
 */

import { vi } from 'vitest';

import type { ClientSession, RunLifecycleEvent, Tree, View } from '../../../src/core/transport/types.js';

type TreeEventType = 'update' | 'ably-message' | 'run';
type TransportEventType = 'error';
type Handler = ((...args: never[]) => void) | (() => void);

export interface MockTransport {
  session: ClientSession<unknown, string>;
  send: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  waitForRun: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Fire an event on the transport (only 'error'). */
  emit: (event: TransportEventType, ...args: unknown[]) => void;
  /** Fire an event on tree/view (update, ably-message, run). */
  emitTree: (event: TreeEventType, ...args: unknown[]) => void;
  tree: Tree<string>;
  view: View<unknown, string>;
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
    kind: 'message' as const,
    message: m,
    msgId: `msg-${String(i)}`,
    parentId: undefined,
    forkOf: undefined,
    headers: {},
    serial: undefined,
  }));

  const tree: Tree<string> = {
    getSiblings: vi.fn((msgId: string) => [msgId]),
    hasSiblings: vi.fn(() => false),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    getActiveRunIds: vi.fn(() => new Map<string, Set<string>>()),
    on: makeTreeOn(treeHandlers),
  };

  const mockRun = {
    stream: new ReadableStream(),
    runId: 'run-1',
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    optimisticMsgIds: [] as string[],
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const regenerate = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const edit = vi.fn(() => Promise.resolve(mockRun));

  const view: View<unknown, string> = {
    getMessages: vi.fn(() => initialMessages),
    flattenNodes: vi.fn(() => initialNodes),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    getSelectedIndex: vi.fn(() => 0),
    getSiblings: vi.fn((msgId: string) => [msgId]),
    hasSiblings: vi.fn(() => false),
    getNode: vi.fn(),
    send,
    regenerate,
    edit,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    update: vi.fn(() => Promise.resolve(mockRun)),
    getActiveRunIds: vi.fn(() => new Map<string, Set<string>>()),
    on: makeTreeOn(viewHandlers),
    close: vi.fn(),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const cancel = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const waitForRun = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const close = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const connect = vi.fn(() => Promise.resolve());

  const createView = vi.fn(() => view);

  const session = {
    tree,
    view,
    connect,
    createView,
    cancel,
    waitForRun,
    on,
    close,
    // CAST: mock object satisfies the subset of ClientSession methods used by hooks
  } as unknown as ClientSession<unknown, string>;

  return {
    session,
    send,
    regenerate,
    edit,
    cancel,
    waitForRun,
    close,
    connect,
    on,
    emit,
    emitTree,
    tree,
    view,
  };
};

/**
 * Create a mock RunLifecycleEvent.
 * @param type - The event type ('x-ably-run-start' or 'x-ably-run-end').
 * @param runId - The run identifier.
 * @param clientId - The client identifier.
 * @param reason - The end reason (only for run-end events).
 * @returns A RunLifecycleEvent.
 */
export const makeRunEvent = (
  type: 'x-ably-run-start' | 'x-ably-run-end',
  runId: string,
  clientId: string,
  reason?: 'complete' | 'cancelled' | 'error',
): RunLifecycleEvent => {
  if (type === 'x-ably-run-start') {
    return { type, runId, clientId };
  }
  return { type, runId, clientId, reason: reason ?? 'complete' };
};
