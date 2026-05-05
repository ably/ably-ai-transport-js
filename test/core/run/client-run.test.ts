import { beforeEach, describe, expect, it } from 'vitest';

import type { Run } from '../../../src/core/run/index.js';
import { createClientRun } from '../../../src/core/run/index.js';
import { ChannelManager } from '../../../src/core/session/channel-manager.js';
import { DefaultSessionWriter } from '../../../src/core/session/writer.js';
import type { TreeInternal } from '../../../src/core/tree/index.js';
import { DefaultTree } from '../../../src/core/tree/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, createMockRealtime } from '../../helper/mock-realtime.js';
import { type StubCodec, stubCodec } from '../../helper/stub-codec.js';

const headersOf = (message: { extras?: unknown }): Record<string, string> => {
  // CAST: tests own the structure of `extras` they passed in.
  const extras = message.extras as { headers?: Record<string, string> } | undefined;
  return extras?.headers ?? {};
};

interface ClientRunFixture {
  channel: ReturnType<typeof createMockChannel>;
  tree: TreeInternal<string>;
  writer: DefaultSessionWriter<StubCodec>;
}

const makeFixture = (): ClientRunFixture => {
  const channel = createMockChannel();
  const realtime = createMockRealtime(channel);
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const channelManager = new ChannelManager(realtime, 's-1', logger);
  const writer = new DefaultSessionWriter<StubCodec>({
    codec: stubCodec,
    channelManager,
    realtime,
    role: 'user',
    logger,
    isClosed: () => false,
  });
  const tree = new DefaultTree<string>({ logger });
  return { channel, tree, writer };
};

let fixture: ClientRunFixture;
beforeEach(() => {
  fixture = makeFixture();
});

const baseOptions = () => ({
  id: 'r-1',
  status: 'active' as const,
  initiatorClientId: 'alice',
  sessionName: 's-1',
  tree: fixture.tree,
  writer: fixture.writer,
  logger: makeLogger({ logLevel: LogLevel.Silent }),
});

describe('createClientRun', () => {
  it('exposes the supplied id, status, and initiatorClientId', () => {
    const run = createClientRun<StubCodec>({ ...baseOptions(), messageId: 'm-1' });

    expect(run.id).toBe('r-1');
    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('alice');
  });

  it("reads status from the tree (returns 'aborted' after run-end aborted)", () => {
    fixture.tree.applyRunStart({
      id: 'r-1',
      status: 'active',
      controlSignals: [],
      initiatorClientId: 'alice',
    } satisfies Run<string>);
    fixture.tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

    const run = createClientRun<StubCodec>({ ...baseOptions() });

    expect(run.status).toBe('aborted');
  });

  it('exposes controlSignals from the tree', () => {
    fixture.tree.applyRunStart({
      id: 'r-1',
      status: 'active',
      controlSignals: [],
      initiatorClientId: 'alice',
    } satisfies Run<string>);
    fixture.tree.applyControlSignal({ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'alice' });

    const run = createClientRun<StubCodec>({ ...baseOptions() });

    expect(run.controlSignals).toEqual([{ type: 'abort', runId: 'r-1', messageId: 'sig-1', clientId: 'alice' }]);
  });

  describe('toInvocation', () => {
    it('builds an Invocation carrying sessionName, runId, and messageId when present', () => {
      const run = createClientRun<StubCodec>({ ...baseOptions(), messageId: 'm-1' });

      const inv = run.toInvocation();

      expect(inv.sessionName).toBe('s-1');
      expect(inv.runId).toBe('r-1');
      expect(inv.messageId).toBe('m-1');
      expect(inv.stepId).toBeUndefined();
    });

    it('omits messageId from the invocation when not supplied', () => {
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      const inv = run.toInvocation();

      expect(inv.messageId).toBeUndefined();
      expect(Object.keys(inv.toJSON())).toEqual(['sessionName', 'runId']);
    });

    it('toJSON of the produced invocation round-trips back through Invocation.fromJSON', () => {
      const run = createClientRun<StubCodec>({ ...baseOptions(), messageId: 'm-1' });

      const json = run.toInvocation().toJSON();

      expect(json).toEqual({ sessionName: 's-1', runId: 'r-1', messageId: 'm-1' });
    });

    it('returns a fresh invocation on each call', () => {
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      expect(run.toInvocation()).not.toBe(run.toInvocation());
    });
  });

  describe('abort', () => {
    it('publishes x-ably-abort and returns the invocation', async () => {
      // Spec: AIT-AB3.
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const run = createClientRun<StubCodec>({ ...baseOptions(), messageId: 'm-1' });

      const inv = await run.abort();

      expect(fixture.channel.publish).toHaveBeenCalledTimes(1);
      const [wire] = fixture.channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected wire');
      expect(wire.name).toBe(WireMessages.Abort);
      expect(headersOf(wire)[Headers.RunId]).toBe('r-1');
      expect(headersOf(wire)[Headers.Reason]).toBe('aborted');
      expect(inv.runId).toBe('r-1');
      expect(inv.messageId).toBe('m-1');
    });

    it("is a no-op (no publish) when the run is already 'aborted' on the tree (multi-device)", async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      const inv = await run.abort();

      expect(fixture.channel.publish).not.toHaveBeenCalled();
      expect(inv.runId).toBe('r-1');
    });

    it("is a no-op when run status is 'complete'", async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'complete' });
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      await run.abort();

      expect(fixture.channel.publish).not.toHaveBeenCalled();
    });

    it("is a no-op when run status is 'failed'", async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'failed' });
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      await run.abort();

      expect(fixture.channel.publish).not.toHaveBeenCalled();
    });

    it('returns a valid Invocation even on the no-op terminal path', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'complete' });
      const run = createClientRun<StubCodec>({ ...baseOptions(), messageId: 'm-1' });

      const inv = await run.abort();

      expect(inv.toJSON()).toEqual({ sessionName: 's-1', runId: 'r-1', messageId: 'm-1' });
    });

    it('propagates writer publish errors', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.channel.publish.mockRejectedValueOnce(new Error('publish failed'));
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      await expect(run.abort()).rejects.toThrow('publish failed');
    });

    it('rejects with SessionClosed when the underlying writer is closed', async () => {
      // Construct a fixture whose writer reports closed.
      const channel = createMockChannel();
      const realtime = createMockRealtime(channel);
      const logger = makeLogger({ logLevel: LogLevel.Silent });
      const channelManager = new ChannelManager(realtime, 's-1', logger);
      const writer = new DefaultSessionWriter<StubCodec>({
        codec: stubCodec,
        channelManager,
        realtime,
        role: 'user',
        logger,
        isClosed: () => true,
      });
      const tree = new DefaultTree<string>({ logger });
      tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const run = createClientRun<StubCodec>({
        id: 'r-1',
        status: 'active',
        initiatorClientId: 'alice',
        sessionName: 's-1',
        tree,
        writer,
        logger: makeLogger({ logLevel: LogLevel.Silent }),
      });

      await expect(run.abort()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });
  });

  describe('when', () => {
    it('resolves immediately when the run is already in a targeted status', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'complete' });
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      await expect(run.when(['complete', 'aborted', 'failed'])).resolves.toBe('complete');
    });

    it('resolves when the run transitions into a targeted status', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      const promise = run.when(['complete', 'aborted', 'failed']);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

      await expect(promise).resolves.toBe('aborted');
    });

    it('does not resolve while the status remains outside the targeted set', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const run = createClientRun<StubCodec>({ ...baseOptions() });
      let settled = false;
      void run.when(['complete']).then(
        () => (settled = true),
        () => (settled = true),
      );

      // Apply an unrelated tree event — should not satisfy the wait.
      fixture.tree.applyRunStart({
        id: 'r-2',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);

      await Promise.resolve();
      expect(settled).toBe(false);
    });

    it('rejects with RunClosed when the closeSignal fires before the status target is reached', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const closeController = new AbortController();
      const run = createClientRun<StubCodec>({
        ...baseOptions(),
        closeSignal: closeController.signal,
      });

      const promise = run.when(['complete']);
      closeController.abort();

      await expect(promise).rejects.toBeErrorInfoWithCode(ErrorCode.RunClosed);
    });

    it('rejects with RunClosed when the closeSignal is already aborted on entry', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const closeController = new AbortController();
      closeController.abort();
      const run = createClientRun<StubCodec>({
        ...baseOptions(),
        closeSignal: closeController.signal,
      });

      await expect(run.when(['complete'])).rejects.toBeErrorInfoWithCode(ErrorCode.RunClosed);
    });

    it('still resolves a target hit even when closeSignal is supplied — close path is opt-in', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const run = createClientRun<StubCodec>({
        ...baseOptions(),
        closeSignal: new AbortController().signal,
      });

      const promise = run.when(['aborted']);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });

      await expect(promise).resolves.toBe('aborted');
    });
  });

  describe('retry', () => {
    it('publishes x-ably-retry and returns the invocation with the signal messageId', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      const inv = await run.retry();

      expect(fixture.channel.publish).toHaveBeenCalledTimes(1);
      const [wire] = fixture.channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected wire');
      expect(wire.name).toBe(WireMessages.Retry);
      expect(headersOf(wire)[Headers.RunId]).toBe('r-1');
      expect(headersOf(wire)[Headers.Reason]).toBe('retry');
      const wireMessageId = headersOf(wire)[Headers.MessageId];
      expect(wireMessageId).toBeDefined();
      expect(inv.messageId).toBe(wireMessageId);
      expect(inv.runId).toBe('r-1');
      expect(inv.stepId).toBeUndefined();
    });

    it('publishes x-ably-step-id when stepId is supplied (step-level retry)', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'failed' });
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      const inv = await run.retry({ stepId: 's-1' });

      const [wire] = fixture.channel.publishedBatches[0] ?? [];
      if (!wire) throw new Error('expected wire');
      expect(headersOf(wire)[Headers.StepId]).toBe('s-1');
      expect(inv.stepId).toBe('s-1');
    });

    it('publishes regardless of run status (including aborted)', async () => {
      fixture.tree.applyRunStart({
        id: 'r-1',
        status: 'active',
        controlSignals: [],
        initiatorClientId: 'alice',
      } satisfies Run<string>);
      fixture.tree.applyRunEnd({ runId: 'r-1', status: 'aborted' });
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      await run.retry();

      expect(fixture.channel.publish).toHaveBeenCalledTimes(1);
    });

    it('propagates writer publish errors', async () => {
      fixture.channel.publish.mockRejectedValueOnce(new Error('publish failed'));
      const run = createClientRun<StubCodec>({ ...baseOptions() });

      await expect(run.retry()).rejects.toThrow('publish failed');
    });
  });
});
