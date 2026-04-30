import { describe, expect, it, vi } from 'vitest';

import { DefaultTree } from '../../../src/core/tree/index.js';
import { DefaultView } from '../../../src/core/view/index.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const makeLog = () => makeLogger({ logLevel: LogLevel.Silent });

const makeNode = (id: string, serial: string) => ({
  id,
  role: 'user' as const,
  clientId: 'client-1',
  message: `msg:${id}`,
  serial,
});

describe('View', () => {
  describe('messages', () => {
    it('mirrors the tree messages live', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });

      tree.applyMessage(makeNode('a', '01'));
      tree.applyMessage(makeNode('b', '02'));

      expect(view.messages.map((n) => n.id)).toEqual(['a', 'b']);
    });
  });

  describe('subscribe', () => {
    it('fires when the underlying tree changes', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const handler = vi.fn();
      view.subscribe(handler);

      tree.applyMessage(makeNode('a', '01'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns an unsubscribe function that detaches the listener', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const handler = vi.fn();
      const unsubscribe = view.subscribe(handler);

      tree.applyMessage(makeNode('a', '01'));
      unsubscribe();
      tree.applyMessage(makeNode('b', '02'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('isolates exceptions in one subscriber from others', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const good = vi.fn();
      view.subscribe(() => {
        throw new Error('boom');
      });
      view.subscribe(good);

      tree.applyMessage(makeNode('a', '01'));

      expect(good).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('stops firing subscribers after close()', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      const handler = vi.fn();
      view.subscribe(handler);

      view.close();
      tree.applyMessage(makeNode('a', '01'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });

      view.close();
      expect(() => {
        view.close();
      }).not.toThrow();
    });

    it('subscribe() after close returns a no-op unsubscribe', () => {
      const tree = new DefaultTree<string>({ logger: makeLog() });
      const view = new DefaultView<string>({ tree, logger: makeLog() });
      view.close();

      const unsubscribe = view.subscribe(vi.fn());

      expect(() => {
        unsubscribe();
      }).not.toThrow();
    });
  });
});
