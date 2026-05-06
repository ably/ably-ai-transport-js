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
  streaming: false,
  canonical: true,
  ...overrides,
});

const makeTree = () => new DefaultTree<string>({ logger: makeLogger({ logLevel: LogLevel.Silent }) });

const makeRun = (overrides: Partial<Run<string>> & Pick<Run<string>, 'id'>): Run<string> => ({
  status: 'active',
  initiatorClientId: 'client-1',
  controlSignals: [],
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
        streaming: false,
        canonical: true,
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
        streaming: false,
        canonical: true,
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

        expect(tree.runs).toEqual([{ id: 'r-1', status: 'active', initiatorClientId: 'client-1', controlSignals: [] }]);
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

        expect(tree.runs).toEqual([{ id: 'r-1', status: 'active', initiatorClientId: 'first', controlSignals: [] }]);
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
          { id: 'r-1', status: 'complete', initiatorClientId: 'client-1', controlSignals: [] },
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

    describe('applyControlSignal', () => {
      it('records the signal on the targeted run without mutating status', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));

        tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'client-1' });

        expect(tree.runs[0]?.status).toBe('active');
        expect(tree.runs[0]?.controlSignals).toEqual([
          { type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'client-1' },
        ]);
      });

      it('records retry signals with their stepId when supplied', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));

        tree.applyControlSignal({
          type: 'retry',
          runId: 'r-1',
          stepId: 's-1',
          messageId: 'sig-1',
          clientId: 'client-1',
        });

        expect(tree.runs[0]?.controlSignals[0]).toEqual({
          type: 'retry',
          runId: 'r-1',
          stepId: 's-1',
          messageId: 'sig-1',
          clientId: 'client-1',
        });
      });

      it('appends multiple signals in arrival order', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));

        tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });
        tree.applyControlSignal({ type: 'retry', runId: 'r-1', messageId: 'sig-2', clientId: 'b' });

        expect(tree.runs[0]?.controlSignals.map((s) => s.messageId)).toEqual(['sig-1', 'sig-2']);
      });

      it('is idempotent on messageId — duplicate observation is recorded once', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });

        const handler = vi.fn();
        tree.subscribe(handler);
        tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });

        expect(handler).not.toHaveBeenCalled();
        expect(tree.runs[0]?.controlSignals.length).toBe(1);
      });

      it('logs warn and drops when the run is unknown', () => {
        const messages: { level: LogLevel; message: string }[] = [];
        const handler: LogHandler = (message, level) => messages.push({ level, message });
        const tree = new DefaultTree<string>({
          logger: makeLogger({ logHandler: handler, logLevel: LogLevel.Warn }),
        });

        tree.applyControlSignal({ type: 'abort', runId: 'never-started', messageId: 'sig-1', clientId: 'a' });

        expect(messages.some((m) => m.message.includes('run not found'))).toBe(true);
        expect(tree.runs).toEqual([]);
      });

      it('emits the granular control-signal event with the signal and run', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        const handler = vi.fn();
        tree.on('control-signal', handler);

        tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });

        expect(handler).toHaveBeenCalledTimes(1);
        const arg = handler.mock.calls[0]?.[0] as { signal: { messageId: string }; run: { id: string } };
        expect(arg.signal.messageId).toBe('sig-1');
        expect(arg.run.id).toBe('r-1');
      });

      it('does not transition status — the agent must publish run-end (aborted)', () => {
        const tree = makeTree();
        tree.applyRunStart(makeRun({ id: 'r-1' }));
        tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });

        expect(tree.runs[0]?.status).toBe('active');

        tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

        expect(tree.runs[0]?.status).toBe('aborted');
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
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

        expect(tree.steps).toEqual([{ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true }]);
      });

      it('appends multiple steps in arrival order', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
        tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

        expect(tree.steps.map((s) => s.id)).toEqual(['s-1', 's-2']);
      });

      it('preserves the runId from the supplied step', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-7', status: 'active', serial: 's-1', canonical: true });

        expect(tree.steps[0]?.runId).toBe('r-7');
      });

      it('ignores a duplicate step id without disturbing the existing entry', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
        tree.applyStepStart({ id: 's-1', runId: 'r-other', status: 'active', serial: 's-1', canonical: true });

        expect(tree.steps).toEqual([{ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true }]);
      });

      it('fires subscribe', () => {
        const tree = makeTree();
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('does not fire subscribe when the duplicate is ignored', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
        const handler = vi.fn();
        tree.subscribe(handler);

        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe('applyStepEnd', () => {
      it('transitions a known step to the supplied status', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

        tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

        expect(tree.steps).toEqual([{ id: 's-1', runId: 'r-1', status: 'complete', serial: 's-1', canonical: true }]);
      });

      it("transitions a step to 'failed' when the publish supplied that status", () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

        tree.applyStepEnd({ stepId: 's-1', status: 'failed' });

        expect(tree.steps[0]?.status).toBe('failed');
      });

      it('fires subscribe on transition', () => {
        const tree = makeTree();
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
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

      it('ignores step-end for an abandoned step (later step-start retired it)', () => {
        const tree = makeTree();
        // s-2's arrival retires s-1 to 'abandoned' before any step-end
        // could land — abandonment is final. A late step-end from the
        // retired worker is logged and ignored. Spec: AIT-CN3.
        tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
        tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

        tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

        expect(tree.steps.map((s) => s.id)).toEqual(['s-1', 's-2']);
        expect(tree.steps[0]?.status).toBe('abandoned');
        expect(tree.steps[1]?.status).toBe('active');
      });
    });
  });

  describe('streaming', () => {
    it('preserves the streaming flag the inserter supplied', () => {
      const tree = makeTree();
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', streaming: true }));

      expect(tree.messages[0]?.streaming).toBe(true);
    });

    it('clears streaming on every assistant node for a run when run-end lands', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', role: 'assistant', streaming: true }));
      tree.applyMessage(makeNode({ id: 'b', serial: '02', runId: 'r-1', role: 'assistant', streaming: true }));

      tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

      expect(tree.messages.map((n) => n.streaming)).toEqual([false, false]);
    });

    it('does not clear streaming when an abort signal lands — only run-end does', () => {
      // Under the symmetric model, signal observation never mutates state.
      // The agent reacting to the signal publishes run-end (aborted), and
      // that lifecycle wire is what clears streaming.
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', role: 'assistant', streaming: true }));

      tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });
      expect(tree.messages[0]?.streaming).toBe(true);

      tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });
      expect(tree.messages[0]?.streaming).toBe(false);
    });

    it('clears streaming when a step-end lands for the run', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', role: 'assistant', streaming: true }));

      tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

      expect(tree.messages[0]?.streaming).toBe(false);
    });

    it('does not flip nodes from another run when a run-end lands', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunStart(makeRun({ id: 'r-2' }));
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', role: 'assistant', streaming: true }));
      tree.applyMessage(makeNode({ id: 'b', serial: '02', runId: 'r-2', role: 'assistant', streaming: true }));

      tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

      expect(tree.messages[0]?.streaming).toBe(false);
      expect(tree.messages[1]?.streaming).toBe(true);
    });

    it('updateMessage preserves the streaming flag', () => {
      const tree = makeTree();
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', streaming: true, message: 'hello' }));

      tree.updateMessage('a', 'hello world');

      expect(tree.messages[0]?.streaming).toBe(true);
      expect(tree.messages[0]?.message).toBe('hello world');
    });
  });

  describe('getRun', () => {
    it('returns the recorded run by id', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));

      expect(tree.getRun('r-1')?.id).toBe('r-1');
    });

    it('returns undefined for an unknown id', () => {
      const tree = makeTree();

      expect(tree.getRun('never-started')).toBeUndefined();
    });

    it('reflects the latest lifecycle status', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

      expect(tree.getRun('r-1')?.status).toBe('aborted');
    });
  });

  describe('getStep', () => {
    it('returns the recorded step by id', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

      expect(tree.getStep('s-1')?.id).toBe('s-1');
    });

    it('returns undefined for an unknown id', () => {
      const tree = makeTree();

      expect(tree.getStep('never-started')).toBeUndefined();
    });

    it('reflects the latest lifecycle status', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

      expect(tree.getStep('s-1')?.status).toBe('complete');
    });
  });

  describe('applyStepStart re-activation', () => {
    it("re-activates a 'failed' run when a fresh step-start lands", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunEnd({ runId: 'r-1', status: 'failed' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.getRun('r-1')?.status).toBe('active');
    });

    it("re-activates an 'aborted' run when a fresh step-start lands", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.getRun('r-1')?.status).toBe('active');
    });

    it("re-activates a 'complete' run when a fresh step-start lands", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunEnd({ runId: 'r-1', status: 'complete' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.getRun('r-1')?.status).toBe('active');
    });

    it("does not change status when the run is already 'active'", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));

      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

      expect(tree.getRun('r-1')?.status).toBe('active');
    });
  });

  describe('granular events', () => {
    it("fires 'step-ended' when a step transitions terminal", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

      const handler = vi.fn();
      tree.on('step-ended', handler);
      tree.applyStepEnd({ stepId: 's-1', status: 'failed' });

      expect(handler).toHaveBeenCalledTimes(1);
      const arg = handler.mock.calls[0]?.[0] as { step: { id: string; status: string }; run: { id: string } };
      expect(arg.step.id).toBe('s-1');
      expect(arg.step.status).toBe('failed');
      expect(arg.run.id).toBe('r-1');
    });

    it('off() removes a previously registered handler', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      const handler = vi.fn();
      tree.on('control-signal', handler);
      tree.off('control-signal', handler);

      tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'a' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('canonical-step rule (Spec: AIT-CN2, AIT-CN3)', () => {
    it("a sole 'active' step is canonical", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

      expect(tree.steps[0]).toMatchObject({ status: 'active', canonical: true });
    });

    it("a sole 'complete' step is canonical", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

      expect(tree.steps[0]).toMatchObject({ status: 'complete', canonical: true });
    });

    it("a sole 'failed' step (no retry yet) is canonical", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'failed' });

      expect(tree.steps[0]).toMatchObject({ status: 'failed', canonical: true });
    });

    it("multi-step success keeps every 'complete' step canonical (continuations contribute to current state)", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'complete' });
      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });
      tree.applyStepEnd({ stepId: 's-2', status: 'complete' });

      expect(tree.steps[0]).toMatchObject({ id: 's-1', status: 'complete', canonical: true });
      expect(tree.steps[1]).toMatchObject({ id: 's-2', status: 'complete', canonical: true });
    });

    it("retry of a 'failed' run flips the failed predecessor to non-canonical", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'failed' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.steps[0]).toMatchObject({ id: 's-1', status: 'failed', canonical: false });
      expect(tree.steps[1]).toMatchObject({ id: 's-2', status: 'active', canonical: true });
    });

    it("retry of an 'aborted' run flips the aborted predecessor to non-canonical", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'aborted' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.steps[0]).toMatchObject({ id: 's-1', status: 'aborted', canonical: false });
      expect(tree.steps[1]).toMatchObject({ id: 's-2', status: 'active', canonical: true });
    });

    it("crash recovery — a later step-start abandons a still-'active' prior step", () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.steps[0]).toMatchObject({ id: 's-1', status: 'abandoned', canonical: false });
      expect(tree.steps[1]).toMatchObject({ id: 's-2', status: 'active', canonical: true });
    });

    it("abandonment clears streaming on the abandoned step's nodes", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyMessage(
        makeNode({ id: 'a', serial: '01', runId: 'r-1', stepId: 's-1', role: 'assistant', streaming: true }),
      );

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.messages[0]?.streaming).toBe(false);
      expect(tree.messages[0]?.canonical).toBe(false);
    });

    it('flips canonical to false on every node belonging to a retired step', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', stepId: 's-1', role: 'assistant' }));
      tree.applyMessage(makeNode({ id: 'b', serial: '02', runId: 'r-1', stepId: 's-1', role: 'assistant' }));
      tree.applyStepEnd({ stepId: 's-1', status: 'failed' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.messages[0]?.canonical).toBe(false);
      expect(tree.messages[1]?.canonical).toBe(false);
    });

    it("does not flip canonical on prior 'complete' steps' nodes when a new step-start lands", () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', stepId: 's-1', role: 'assistant' }));
      tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      expect(tree.messages[0]?.canonical).toBe(true);
    });

    it('does not flip canonical on nodes from another run', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyRunStart(makeRun({ id: 'r-2' }));
      tree.applyStepStart({ id: 's-r1-1', runId: 'r-1', status: 'active', serial: 's-r1-1', canonical: true });
      tree.applyStepStart({ id: 's-r2-1', runId: 'r-2', status: 'active', serial: 's-r2-1', canonical: true });
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-2', stepId: 's-r2-1', role: 'assistant' }));
      tree.applyStepEnd({ stepId: 's-r1-1', status: 'failed' });

      // A retry on r-1 should not touch r-2's step or its nodes.
      tree.applyStepStart({ id: 's-r1-2', runId: 'r-1', status: 'active', serial: 's-r1-2', canonical: true });

      expect(tree.steps.find((s) => s.id === 's-r2-1')).toMatchObject({ canonical: true });
      expect(tree.messages[0]?.canonical).toBe(true);
    });

    it('a node arriving with no observed step defaults to canonical: true', () => {
      const tree = makeTree();
      tree.applyMessage(
        makeNode({ id: 'a', serial: '01', runId: 'r-1', stepId: 's-not-yet-observed', role: 'assistant' }),
      );

      // Out-of-order delivery — step-start arrives later. The default assumes
      // the step is canonical; if the step turns out to be retired by a
      // later step-start, the tree's flip-on-retire logic updates the node.
      expect(tree.messages[0]?.canonical).toBe(true);
    });

    it('a node with no stepId is always canonical (user messages, run-start payloads)', () => {
      const tree = makeTree();
      tree.applyMessage(makeNode({ id: 'u', serial: '01', runId: 'r-1', role: 'user' }));

      expect(tree.messages[0]?.canonical).toBe(true);
    });

    it('an arriving node attached to a retired step inherits canonical: false', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepEnd({ stepId: 's-1', status: 'failed' });
      // s-2's arrival flips s-1 to non-canonical.
      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });

      // A late-arriving node from the failed s-1 (rare — this could happen
      // with mid-stream reconnect / hydration backfill) inherits the step's
      // current canonical: false.
      tree.applyMessage(makeNode({ id: 'late', serial: '99', runId: 'r-1', stepId: 's-1', role: 'assistant' }));

      expect(tree.messages.find((n) => n.id === 'late')?.canonical).toBe(false);
    });

    it('ignores a wire step-end on an already-abandoned step', () => {
      const tree = makeTree();
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });
      // s-1 is now 'abandoned'. A late wire step-end (e.g. the original
      // worker eventually publishing 'complete' before discovering it
      // was abandoned) is logged and ignored.
      tree.applyStepEnd({ stepId: 's-1', status: 'complete' });

      expect(tree.steps[0]).toMatchObject({ status: 'abandoned', canonical: false });
    });

    it('does not retire a later-serial sibling when an older step-start arrives after it', () => {
      // Hypothetical out-of-order arrival (a hydration replay edge case
      // brings an older serial after a newer one already landed live).
      // The rule is "no later-serial step-start exists in the same
      // run", so the older arrival must not retire the newer one.
      // Spec: AIT-CN2.
      const tree = makeTree();
      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });

      // s-2 (the later-serial sibling) must still be canonical and
      // active — the older s-1 does not have authority to retire it.
      expect(tree.steps.find((s) => s.id === 's-2')).toMatchObject({ status: 'active', canonical: true });
      // s-1 itself remains 'active' here too — it was the earlier
      // arrival from a serial-ordering perspective, so on its own
      // arrival there are no "earlier-serial siblings" to retire.
      expect(tree.steps.find((s) => s.id === 's-1')).toMatchObject({ status: 'active', canonical: true });
    });

    it('preserves canonical: false through a streaming updateMessage on a retired step', () => {
      const tree = makeTree();
      tree.applyRunStart(makeRun({ id: 'r-1' }));
      tree.applyStepStart({ id: 's-1', runId: 'r-1', status: 'active', serial: 's-1', canonical: true });
      tree.applyMessage(makeNode({ id: 'a', serial: '01', runId: 'r-1', stepId: 's-1', role: 'assistant' }));
      tree.applyStepEnd({ stepId: 's-1', status: 'failed' });
      // Retire s-1.
      tree.applyStepStart({ id: 's-2', runId: 'r-1', status: 'active', serial: 's-2', canonical: true });
      expect(tree.messages[0]?.canonical).toBe(false);

      // A subsequent updateMessage on the retired-step node must
      // preserve the canonical: false flip — `updateMessage` only
      // replaces the composed message body, not other node fields.
      tree.updateMessage('a', 'msg:a (revised)');

      expect(tree.messages[0]?.canonical).toBe(false);
      expect(tree.messages[0]?.message).toBe('msg:a (revised)');
    });
  });
});
