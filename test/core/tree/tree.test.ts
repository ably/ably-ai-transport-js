import { describe, expect, it, vi } from 'vitest';

import type { Run } from '../../../src/core/run/index.js';
import type { MessageNode } from '../../../src/core/tree/index.js';
import { DefaultTree } from '../../../src/core/tree/index.js';
import type { LogHandler } from '../../../src/logger.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const makeNode = (
  overrides: Partial<MessageNode<string>> & Pick<MessageNode<string>, 'id' | 'serial'>,
): MessageNode<string> => ({
  role: 'user',
  clientId: 'client-1',
  runId: 'r-1',
  message: `msg:${overrides.id}`,
  ...overrides,
});

const makeTree = () => new DefaultTree<string>({ logger: makeLogger({ logLevel: LogLevel.Silent }) });

const makeRun = (overrides: Partial<Run<string>> & Pick<Run<string>, 'id'>): Run<string> => ({
  status: 'active',
  abortRequested: false,
  initiatorClientId: 'client-1',
  ...overrides,
});

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
        runId: 'r-1',
        message: 'hello',
      });

      tree.applyMessage(node);

      expect(tree.messages[0]).toEqual({
        id: 'a',
        serial: '01',
        role: 'assistant',
        clientId: 'agent-1',
        runId: 'r-1',
        message: 'hello',
      });
    });
  });

  describe('updateMessage', () => {
    it('replaces the composed message on an existing node and notifies subscribers', () => {
      const tree = makeTree();
      tree.applyMessage(makeNode({ id: 'a', serial: '01', message: 'hello' }));
      const handler = vi.fn();
      tree.subscribe(handler);

      tree.updateMessage('a', 'hello world');

      expect(tree.messages[0]?.message).toBe('hello world');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('preserves serial and metadata fields when updating', () => {
      const tree = makeTree();
      tree.applyMessage(
        makeNode({ id: 'a', serial: '01', clientId: 'alice', runId: 'r-1', role: 'assistant', message: 'hello' }),
      );

      tree.updateMessage('a', 'world');

      expect(tree.messages[0]).toEqual({
        id: 'a',
        serial: '01',
        clientId: 'alice',
        runId: 'r-1',
        role: 'assistant',
        message: 'world',
      });
    });

    it('warns and is a no-op when the id does not match a known node', () => {
      const logHandler = vi.fn<LogHandler>();
      const tree = new DefaultTree<string>({
        logger: makeLogger({ logLevel: LogLevel.Warn, logHandler }),
      });
      const handler = vi.fn();
      tree.subscribe(handler);

      tree.updateMessage('does-not-exist', 'hello');

      expect(tree.messages).toEqual([]);
      expect(handler).not.toHaveBeenCalled();
      expect(logHandler).toHaveBeenCalledTimes(1);
      const [message, level, context] = logHandler.mock.calls[0] ?? [];
      expect(level).toBe(LogLevel.Warn);
      expect(message).toContain('DefaultTree.updateMessage(); node not found');
      expect(context).toMatchObject({ id: 'does-not-exist' });
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

  describe('runs', () => {
    describe('applyRunStart', () => {
      it('records the run as active', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));

        expect(tree.runs).toEqual([
          { id: 'r-1', status: 'active', abortRequested: false, initiatorClientId: 'client-1' },
        ]);
      });

      it('appends multiple runs in arrival order', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyRunStart(makeRun({ id: 'r-2' }));

        expect(tree.runs.map((r) => r.id)).toEqual(['r-1', 'r-2']);
      });

      it('preserves the initiatorClientId from the supplied run', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1', initiatorClientId: 'agent-7' }));

        expect(tree.runs[0]?.initiatorClientId).toBe('agent-7');
      });

      it('ignores a duplicate run id without disturbing the existing entry', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1', initiatorClientId: 'first' }));
        tree.applyRunStart(makeRun({ id: 'r-1', initiatorClientId: 'second' }));

        expect(tree.runs).toEqual([{ id: 'r-1', status: 'active', abortRequested: false, initiatorClientId: 'first' }]);
      });

      it('fires subscribe', () => {
        const tree = makeTree();
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyRunStart(makeRun({ id: 'r-1' }));

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('does not fire subscribe when the duplicate is ignored', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyRunStart(makeRun({ id: 'r-1' }));

        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe('applyRunEnd', () => {
      it('transitions a known run to the supplied status', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));

        tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

        expect(tree.runs).toEqual([
          { id: 'r-1', status: 'complete', abortRequested: false, initiatorClientId: 'client-1' },
        ]);
      });

      it('fires subscribe on transition', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('ignores run-end for an unknown run id', () => {
        const tree = makeTree();
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyRunEnd({ runId: 'never-started', status: 'complete' });

        expect(tree.runs).toEqual([]);
        expect(handler).not.toHaveBeenCalled();
      });

      it('preserves run order when an earlier run transitions terminal', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyRunStart(makeRun({ id: 'r-2' }));

        tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

        expect(tree.runs.map((r) => r.id)).toEqual(['r-1', 'r-2']);
        expect(tree.runs[0]?.status).toBe('complete');
        expect(tree.runs[1]?.status).toBe('active');
      });
    });

    describe('applyAbort', () => {
      it("sets abortRequested and synthesises status to 'aborted'", () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));

        tree.applyAbort({ runId: 'r-1' });

        expect(tree.runs[0]?.abortRequested).toBe(true);
        expect(tree.runs[0]?.status).toBe('aborted');
      });

      it('notifies subscribers exactly once for the first abort observation', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyAbort({ runId: 'r-1' });

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('is idempotent — second abort observation is a no-op (no notify)', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyAbort({ runId: 'r-1' });

        const handler = vi.fn();
        tree.subscribe(handler);
        tree.applyAbort({ runId: 'r-1' });

        expect(handler).not.toHaveBeenCalled();
        expect(tree.runs[0]?.status).toBe('aborted');
      });

      it('logs warn and drops when the run is unknown', () => {
        const messages: { level: LogLevel; message: string }[] = [];
        const handler: LogHandler = (message, level) => messages.push({ level, message });
        const tree = new DefaultTree<string>({
          logger: makeLogger({ logHandler: handler, logLevel: LogLevel.Warn }),
        });

        tree.applyAbort({ runId: 'never-started' });

        expect(messages.some((m) => m.message.includes('run not found'))).toBe(true);
        expect(tree.runs).toEqual([]);
      });

      it('aborted runs override later run-end (aborted) — confirmation is logged at debug', () => {
        const messages: { level: LogLevel; message: string }[] = [];
        const handler: LogHandler = (message, level) => messages.push({ level, message });
        const tree = new DefaultTree<string>({
          logger: makeLogger({ logHandler: handler, logLevel: LogLevel.Debug }),
        });
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyAbort({ runId: 'r-1' });

        tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

        expect(tree.runs[0]?.status).toBe('aborted');
        expect(messages.some((m) => m.message.includes('confirmation for aborted run'))).toBe(true);
      });

      it('aborted runs override later run-end (complete) — conflict is logged at warn', () => {
        const messages: { level: LogLevel; message: string }[] = [];
        const handler: LogHandler = (message, level) => messages.push({ level, message });
        const tree = new DefaultTree<string>({
          logger: makeLogger({ logHandler: handler, logLevel: LogLevel.Warn }),
        });
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyAbort({ runId: 'r-1' });

        tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

        expect(tree.runs[0]?.status).toBe('aborted');
        expect(messages.some((m) => m.message.includes('abort overrides observed run-end'))).toBe(true);
      });
    });

    it('runs and messages share the same coarse subscribe channel', () => {
      const tree = makeTree();
      const handler = vi.fn();
      tree.subscribe(handler);

      tree.applyMessage(makeNode({ id: 'a', serial: '01' }));
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  describe('steps', () => {
    describe('applyStepStart', () => {
      it('records the step as active', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });

        expect(tree.steps).toEqual([{ id: 's-1', runId: 'r-1', status: 'active' }]);
      });

      it('appends multiple steps in arrival order', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });
        tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active' });

        expect(tree.steps.map((s) => s.id)).toEqual(['s-1', 's-2']);
      });

      it('preserves the runId from the supplied step', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-7', status: 'active' });

        expect(tree.steps[0]?.runId).toBe('r-7');
      });

      it('ignores a duplicate step id without disturbing the existing entry', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });
        tree.applyStepStart({ id: 's-1', runId: 'r-other', status: 'active' });

        expect(tree.steps).toEqual([{ id: 's-1', runId: 'r-1', status: 'active' }]);
      });

      it('fires subscribe', () => {
        const tree = makeTree();
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('does not fire subscribe when the duplicate is ignored', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });

        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe('applyStepEnd', () => {
      it('transitions a known step to the supplied status', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });

        tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

        expect(tree.steps).toEqual([{ id: 's-1', runId: 'r-1', status: 'complete' }]);
      });

      it("transitions a step to 'failed' when the publish supplied that status", () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });

        tree.applyStepEnd({ stepId: 's-1', status: 'failed' });

        expect(tree.steps[0]?.status).toBe('failed');
      });

      it('fires subscribe on transition', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('ignores step-end for an unknown step id', () => {
        const tree = makeTree();
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyStepEnd({ stepId: 'never-started', status: 'complete' });

        expect(tree.steps).toEqual([]);
        expect(handler).not.toHaveBeenCalled();
      });

      it('preserves step order when an earlier step transitions terminal', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active' });
        tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active' });

        tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

        expect(tree.steps.map((s) => s.id)).toEqual(['s-1', 's-2']);
        expect(tree.steps[0]?.status).toBe('complete');
        expect(tree.steps[1]?.status).toBe('active');
      });
    });
  });
});
