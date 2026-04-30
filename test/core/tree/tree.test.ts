import { describe, expect, it, vi } from 'vitest';

import type { MessageNode } from '../../../src/core/tree/index.js';
import { DefaultTree } from '../../../src/core/tree/index.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const makeNode = (
  overrides: Partial<MessageNode<string>> & Pick<MessageNode<string>, 'id' | 'serial'>,
): MessageNode<string> => ({
  role: 'user',
  clientId: 'client-1',
  message: `msg:${overrides.id}`,
  ...overrides,
});

const makeTree = () => new DefaultTree<string>({ logger: makeLogger({ logLevel: LogLevel.Silent }) });

describe('Tree', () => {
  describe('applyMessage', () => {
    it('appends a single node to the messages array', () => {
      const tree = makeTree();
      const node = makeNode({ id: 'a', serial: '01' });

      tree.applyMessage(node);

      expect(tree.messages).toEqual([node]);
    });

    it('appends in-order nodes in the order they arrive', () => {
      const tree = makeTree();
      const a = makeNode({ id: 'a', serial: '01' });
      const b = makeNode({ id: 'b', serial: '02' });
      const c = makeNode({ id: 'c', serial: '03' });

      tree.applyMessage(a);
      tree.applyMessage(b);
      tree.applyMessage(c);

      expect(tree.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('sorts an out-of-order arrival into its serial-ordered position', () => {
      const tree = makeTree();
      const a = makeNode({ id: 'a', serial: '01' });
      const c = makeNode({ id: 'c', serial: '03' });
      const b = makeNode({ id: 'b', serial: '02' });

      tree.applyMessage(a);
      tree.applyMessage(c);
      tree.applyMessage(b);

      expect(tree.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('inserts a node before all existing entries when its serial is the smallest', () => {
      const tree = makeTree();
      const b = makeNode({ id: 'b', serial: '02' });
      const c = makeNode({ id: 'c', serial: '03' });
      const a = makeNode({ id: 'a', serial: '01' });

      tree.applyMessage(b);
      tree.applyMessage(c);
      tree.applyMessage(a);

      expect(tree.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('preserves all per-node fields on the inserted node', () => {
      const tree = makeTree();
      const node = makeNode({
        id: 'a',
        serial: '01',
        role: 'assistant',
        clientId: 'agent-1',
        message: 'hello',
      });

      tree.applyMessage(node);

      expect(tree.messages[0]).toEqual({
        id: 'a',
        serial: '01',
        role: 'assistant',
        clientId: 'agent-1',
        message: 'hello',
      });
    });
  });

  describe('subscribe', () => {
    it('fires the callback after applyMessage', () => {
      const tree = makeTree();
      const handler = vi.fn();
      tree.subscribe(handler);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('fires once per applyMessage call', () => {
      const tree = makeTree();
      const handler = vi.fn();
      tree.subscribe(handler);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));
      tree.applyMessage(makeNode({ id: 'b', serial: '02' }));
      tree.applyMessage(makeNode({ id: 'c', serial: '03' }));

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('fires every registered handler', () => {
      const tree = makeTree();
      const a = vi.fn();
      const b = vi.fn();
      tree.subscribe(a);
      tree.subscribe(b);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('returns an unsubscribe function that stops further notifications', () => {
      const tree = makeTree();
      const handler = vi.fn();
      const unsubscribe = tree.subscribe(handler);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));
      unsubscribe();
      tree.applyMessage(makeNode({ id: 'b', serial: '02' }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe is idempotent', () => {
      const tree = makeTree();
      const handler = vi.fn();
      const unsubscribe = tree.subscribe(handler);

      unsubscribe();
      unsubscribe();
      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('isolates exceptions thrown from one handler so others still fire', () => {
      const tree = makeTree();
      const good = vi.fn();
      tree.subscribe(() => {
        throw new Error('handler exploded');
      });
      tree.subscribe(good);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));

      expect(good).toHaveBeenCalledTimes(1);
    });

    it('lets a handler unsubscribe itself during notification without disturbing the others', () => {
      const tree = makeTree();
      const other = vi.fn();
      const unsubscribeSelf = tree.subscribe(() => {
        unsubscribeSelf();
      });
      tree.subscribe(other);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));
      tree.applyMessage(makeNode({ id: 'b', serial: '02' }));

      // The self-unsubscribing handler fires once on the first applyMessage,
      // then is gone. `other` still fires for every applyMessage.
      expect(other).toHaveBeenCalledTimes(2);
    });
  });

  describe('messages projection', () => {
    it('exposes the messages array as readonly to the consumer', () => {
      const tree = makeTree();
      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));
      const messages = tree.messages;

      // The compile-time `readonly` is the contract; at runtime the same array
      // continues to reflect later applyMessage calls.
      tree.applyMessage(makeNode({ id: 'b', serial: '02' }));
      expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });
});
