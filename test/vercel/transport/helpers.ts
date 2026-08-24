/**
 * Test fixtures shared by the chat-transport unit tests: WireMeta and
 * classified transport-event builders, plus a fake `ClientTransport` that
 * records publishes, lets a test emit events and errors into the subscription
 * like the channel would, settle a publish's run-id promise, and queue history
 * batches for the hydration walk.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { vi } from 'vitest';

import type {
  ClientTransport,
  PublishInputOptions,
  PublishInputResult,
  SteerResult,
  TransportEvent,
  TransportHistoryResult,
  WireMeta,
} from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';

/** A classified transport event at the Vercel default instantiation. */
export type Event = TransportEvent<VercelInput, VercelOutput>;

/** Shared no-op for the fake's inert callbacks. */
const noop = (): void => {
  /* inert */
};

/**
 * Build a full WireMeta with every field defaulted; override what the test
 * cares about.
 * @param overrides - The fields the test pins.
 * @returns The WireMeta.
 */
const makeMeta = (overrides: Partial<WireMeta> = {}): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: 'serial-1',
  transportMessageId: undefined,
  runId: undefined,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: undefined,
  role: undefined,
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  inputTransportMessageId: undefined,
  inputTransportMessageIds: undefined,
  steerTransportMessageIds: undefined,
  ...overrides,
});

/**
 * A classified `message` event carrying decoded inputs and/or outputs.
 * @param meta - WireMeta overrides for the event.
 * @param content - The decoded inputs and outputs.
 * @param content.inputs - The decoded inputs (defaults to none).
 * @param content.outputs - The decoded outputs (defaults to none).
 * @returns The event.
 */
export const messageEvent = (
  meta: Partial<WireMeta>,
  content: { inputs?: VercelInput[]; outputs?: VercelOutput[] },
): Event => ({
  kind: 'message',
  meta: makeMeta(meta),
  inputs: content.inputs ?? [],
  outputs: content.outputs ?? [],
});

/**
 * The chunk sequence for one whole assistant message, ready to hand to the
 * provider reducer.
 * @param messageId - The assistant message's domain id.
 * @param text - The message's text.
 * @returns The chunks, in wire order.
 */
export const assistantChunks = (messageId: string, text: string): AI.UIMessageChunk[] => [
  { type: 'start', messageId },
  { type: 'text-start', id: `${messageId}-t` },
  { type: 'text-delta', id: `${messageId}-t`, delta: text },
  { type: 'text-end', id: `${messageId}-t` },
  { type: 'finish' },
];

/**
 * A run-lifecycle `start` event for a run.
 * @param runId - The run's id.
 * @param serial - The event's serial (defaults to `serial-start`).
 * @returns The event.
 */
export const runStartEvent = (runId: string, serial = 'serial-start'): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'start', runId, clientId: 'agent', invocationId: '', serial },
});

/**
 * A run-lifecycle `end` event for a run.
 * @param runId - The run's id.
 * @param reason - Why the run ended (defaults to `complete`).
 * @returns The event.
 */
export const runEndEvent = (runId: string, reason: 'complete' | 'cancelled' = 'complete'): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'end', runId, clientId: 'agent', invocationId: '', serial: 'serial-end', reason },
});

/**
 * A run-lifecycle `end` event whose run failed.
 * @param runId - The run's id.
 * @param error - The run's error.
 * @returns The event.
 */
export const runErrorEvent = (runId: string, error: Ably.ErrorInfo): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'end', runId, clientId: 'agent', invocationId: '', serial: 'serial-end', reason: 'error', error },
});

/**
 * A run-lifecycle `suspend` event for a run.
 * @param runId - The run's id.
 * @returns The event.
 */
export const runSuspendEvent = (runId: string): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'suspend', runId, clientId: 'agent', invocationId: '', serial: 'serial-suspend' },
});

/**
 * A step-lifecycle `step-start` event — a step attempt opening.
 * @param runId - The run the step belongs to.
 * @param stepId - The step's id, stable across attempts.
 * @param serial - The attempt's start serial.
 * @returns The event.
 */
export const stepStartEvent = (runId: string, stepId: string, serial = 'serial-step'): Event => ({
  kind: 'step-lifecycle',
  event: {
    type: 'step-start',
    runId,
    stepId,
    invocationId: '',
    runClientId: 'agent',
    invocationClientId: '',
    stepClientId: '',
    serial,
  },
});

/**
 * Stub the global fetch the chat route POST goes through.
 *
 * Builds a fresh `Response` per call, so a test that POSTs twice does not hit
 * an already-read body.
 * @param status - The HTTP status to answer with (defaults to 200).
 * @returns The fetch mock.
 */
export const stubChatFetch = (status = 200): ReturnType<typeof vi.fn> => {
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- a fresh Response per call, resolved synchronously
  const mock = vi.fn(() => Promise.resolve(new Response('', { status })));
  vi.stubGlobal('fetch', mock);
  return mock;
};

/**
 * Stub the global fetch so every call rejects, like an unreachable route.
 * @param error - The rejection.
 * @returns The fetch mock.
 */
export const stubChatFetchFailure = (error: Error): ReturnType<typeof vi.fn> => {
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejects synchronously
  const mock = vi.fn(() => Promise.reject(error));
  vi.stubGlobal('fetch', mock);
  return mock;
};

/**
 * Read a chunk stream to completion.
 * @param stream - The stream to drain.
 * @returns The collected chunks.
 */
export const readAll = async (stream: ReadableStream<AI.UIMessageChunk>): Promise<AI.UIMessageChunk[]> => {
  const chunks: AI.UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
};

/**
 * A fake `ClientTransport` for driving the chat transport under test.
 *
 * Records `publishInput` and `cancel` calls, exposes {@link emit} and
 * {@link emitError} so a test can push classified events and transport errors
 * into the subscription like the channel would, lets a test settle the run-id
 * promise a publish returned, and serves queued history batches to the walk.
 */
export class FakeClientTransport implements ClientTransport<VercelInput, VercelOutput> {
  /** Every publishInput call, in order. */
  readonly published: { event: VercelInput; opts: PublishInputOptions | undefined }[] = [];
  /** Every cancelled run-id, in order. */
  readonly cancelled: string[] = [];
  /** History batches served to `history()`, in call order; empty means exhausted-empty. */
  historyBatches: TransportHistoryResult<VercelInput, VercelOutput>[] = [];
  /**
   * When set, every publish's run-id promise resolves with it immediately —
   * the ordinary case, where `ai-run-start` is already on the wire. Leave it
   * unset to settle each publish by hand with {@link resolveRunId}.
   */
  autoRunId: string | undefined;

  private readonly _handlers = new Set<(event: Event) => void>();
  private readonly _errorHandlers = new Set<(error: Ably.ErrorInfo) => void>();
  private readonly _runIdDeferreds: {
    resolve: (runId: string) => void;
    reject: (error: Ably.ErrorInfo) => void;
  }[] = [];
  private _publishCount = 0;

  /**
   * Push a classified event to every subscriber, like a channel delivery.
   * @param event - The event to deliver.
   */
  emit(event: Event): void {
    for (const handler of this._handlers) handler(event);
  }

  /**
   * Push a transport error to every `on('error')` subscriber.
   * @param error - The error to deliver.
   */
  emitError(error: Ably.ErrorInfo): void {
    for (const handler of this._errorHandlers) handler(error);
  }

  /**
   * Settle the run-id promise of a publish, oldest unsettled first.
   * @param runId - The run id the agent minted.
   */
  resolveRunId(runId: string): void {
    this._runIdDeferreds.shift()?.resolve(runId);
  }

  /**
   * Fail the run-id promise of a publish, oldest unsettled first — a run that
   * never started.
   * @param error - The failure.
   */
  rejectRunId(error: Ably.ErrorInfo): void {
    this._runIdDeferreds.shift()?.reject(error);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
  async connect(): Promise<void> {
    return;
  }

  subscribe(handler: (event: Event) => void): () => void {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  on(event: 'event', handler: (e: Event) => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'error', handler: (err: Ably.ErrorInfo) => void): () => void;
  on(event: 'event' | 'ably-message' | 'error', handler: (arg: never) => void): () => void {
    if (event === 'event') {
      // CAST: the overload above pins the handler's argument per event name.
      const typed = handler as unknown as (e: Event) => void;
      this._handlers.add(typed);
      return () => this._handlers.delete(typed);
    }
    if (event === 'error') {
      // CAST: as above.
      const typed = handler as unknown as (err: Ably.ErrorInfo) => void;
      this._errorHandlers.add(typed);
      return () => this._errorHandlers.delete(typed);
    }
    // `ably-message` is not used by the chat transport.
    return noop;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
  async publishInput(event: VercelInput, opts?: PublishInputOptions): Promise<PublishInputResult> {
    this.published.push({ event, opts });
    this._publishCount += 1;
    const { autoRunId } = this;
    const runId =
      autoRunId === undefined
        ? new Promise<string>((resolve, reject) => {
            this._runIdDeferreds.push({ resolve, reject });
          })
        : Promise.resolve(autoRunId);
    return {
      transportMessageId: opts?.transportMessageId ?? `cm-${String(this._publishCount)}`,
      eventId: `ev-${String(this._publishCount)}`,
      runId,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    return;
  }

  steer(): SteerResult {
    throw new Error('steer is not used by the chat transport');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
  async history(): Promise<TransportHistoryResult<VercelInput, VercelOutput>> {
    const batch = this.historyBatches.shift();
    return batch ?? { events: [], exhausted: true };
  }

  close(): void {
    this._handlers.clear();
    this._errorHandlers.clear();
  }
}
