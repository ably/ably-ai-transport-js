/**
 * Shared mock ClientSession for React hook tests.
 */

import { vi } from 'vitest';

import type { CodecInputEvent, CodecOutputEvent } from '../../../src/core/codec/types.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import type {
  BranchSelection,
  ClientSession,
  RunLifecycleEvent,
  RunNode,
  Tree,
  View,
} from '../../../src/core/transport/types.js';

type TreeEventType = 'update' | 'ably-message' | 'run' | 'output';
type SessionEventType = 'error';
type Handler = ((...args: never[]) => void) | (() => void);

const emptyBranchSelection = (): BranchSelection<string> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
});

export interface MockSession {
  session: ClientSession<CodecInputEvent, CodecOutputEvent, unknown, string>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Fire an event on the session (only 'error'). */
  emit: (event: SessionEventType, ...args: unknown[]) => void;
  /** Fire an event on tree/view (update, ably-message, run, output). */
  emitTree: (event: TreeEventType, ...args: unknown[]) => void;
  tree: Tree<CodecOutputEvent, unknown>;
  view: View<CodecInputEvent, string>;
}

export const createMockSession = (initialMessages: string[] = []): MockSession => {
  const sessionHandlers = new Map<string, Set<Handler>>();
  const treeHandlers = new Map<string, Set<Handler>>();
  const viewHandlers = new Map<string, Set<Handler>>();

  const emit = (event: SessionEventType, ...args: unknown[]): void => {
    const set = sessionHandlers.get(event);
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
    let set = sessionHandlers.get(event);
    if (!set) {
      set = new Set();
      sessionHandlers.set(event, set);
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

  const initialNodes: RunNode<unknown>[] = initialMessages.map(
    (_, i): RunNode<unknown> => ({
      key: `run-${String(i)}`,
      runId: `run-${String(i)}`,
      parentRunId: i > 0 ? `run-${String(i - 1)}` : undefined,
      parentCodecMessageId: undefined,
      forkOf: undefined,
      regeneratesCodecMessageId: undefined,
      clientId: '',
      invocationId: '',
      status: 'complete',
      projection: undefined,
      startSerial: undefined,
      endSerial: undefined,
    }),
  );

  const tree: Tree<CodecOutputEvent, unknown> = {
    runs: vi.fn(() => initialNodes),
    getRunNode: vi.fn(),
    getRunByCodecMessageId: vi.fn(),
    getSiblingRuns: vi.fn(() => []),
    hasSiblingRuns: vi.fn(() => false),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires explicit undefined return for the contract
    getRegenerateGroup: vi.fn(() => undefined),
    on: makeTreeOn(treeHandlers),
  };

  const mockRun = {
    stream: new ReadableStream(),
    started: Promise.resolve({ runId: 'run-1', invocationId: 'inv-1' }),
    key: 'run-1',
    inputEventId: '',
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    optimisticCodecMessageIds: [] as string[],
    toInvocation: () =>
      Invocation.fromJSON({ runId: 'run-1', invocationId: 'inv-1', inputEventId: '', sessionName: 'mock-session' }),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const sendMessage = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const sendInput = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const regenerate = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const edit = vi.fn(() => Promise.resolve(mockRun));

  const view: View<CodecInputEvent, string> = {
    getMessages: vi.fn(() => initialMessages),
    runs: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires explicit undefined return for the contract
    runOf: vi.fn(() => undefined),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires explicit undefined return for the contract
    run: vi.fn(() => undefined),
    branchSelection: vi.fn(emptyBranchSelection),
    selectSibling: vi.fn(),
    sendMessage,
    sendInput,
    regenerate,
    edit,
    on: makeTreeOn(viewHandlers),
    close: vi.fn(),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const cancel = vi.fn(() => Promise.resolve());
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
    on,
    close,
    // CAST: mock object satisfies the subset of ClientSession methods used by hooks
  } as unknown as ClientSession<CodecInputEvent, CodecOutputEvent, unknown, string>;

  return {
    session,
    sendMessage,
    sendInput,
    regenerate,
    edit,
    cancel,
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
 * @param type - The event type ('start' or 'end').
 * @param runId - The run identifier.
 * @param clientId - The client identifier.
 * @param reason - The end reason (only for run-end events).
 * @returns A RunLifecycleEvent.
 */
export const makeRunEvent = (
  type: 'start' | 'end',
  runId: string,
  clientId: string,
  reason?: 'complete' | 'cancelled' | 'error',
): RunLifecycleEvent => {
  if (type === 'start') {
    return { type, runId, clientId, serial: undefined, invocationId: '' };
  }
  return { type, runId, clientId, serial: undefined, invocationId: '', reason: reason ?? 'complete' };
};
