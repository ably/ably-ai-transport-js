/**
 * Test fixtures shared by the chat-transport unit tests: WireMeta and
 * classified transport-event builders, plus a fake `ClientTransport` that
 * records publishes and lets a test emit events into the subscription and
 * queue history batches for the reconnect scan.
 */

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
export const makeMeta = (overrides: Partial<WireMeta> = {}): WireMeta => ({
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
 * @returns The event.
 */
export const runEndEvent = (runId: string): Event => ({
  kind: 'run-lifecycle',
  event: { type: 'end', runId, clientId: 'agent', invocationId: '', serial: 'serial-end', reason: 'complete' },
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
 * A fake `ClientTransport` for driving the chat transport under test: records
 * `publishInput` and `cancel` calls, exposes {@link emit} so a test can push
 * classified events into the subscription like the channel would, and serves
 * queued history batches to the reconnect scan.
 */
export class FakeClientTransport implements ClientTransport<VercelInput, VercelOutput> {
  /** Every publishInput call, in order. */
  readonly published: { event: VercelInput; opts: PublishInputOptions | undefined }[] = [];
  /** Every cancelled run-id, in order. */
  readonly cancelled: string[] = [];
  /** History batches served to `history()`, in call order; empty means exhausted-empty. */
  historyBatches: TransportHistoryResult<VercelInput, VercelOutput>[] = [];
  /** How many times `history()` was called. */
  historyCalls = 0;

  private readonly _handlers = new Set<(event: Event) => void>();
  private _publishCount = 0;

  /**
   * Push a classified event to every subscriber, like a channel delivery.
   * @param event - The event to deliver.
   */
  emit(event: Event): void {
    for (const handler of this._handlers) handler(event);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
  async connect(): Promise<void> {
    return;
  }

  subscribe(handler: (event: Event) => void): () => void {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  on(): () => void {
    return noop;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
  async publishInput(event: VercelInput, opts?: PublishInputOptions): Promise<PublishInputResult> {
    this.published.push({ event, opts });
    this._publishCount += 1;
    return {
      transportMessageId: opts?.transportMessageId ?? `cm-${String(this._publishCount)}`,
      eventId: `ev-${String(this._publishCount)}`,
      // Never resolves — the chat transport takes the run-id from the POST
      // response, not from this promise.
      runId: new Promise<string>(noop),
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
    this.historyCalls += 1;
    const batch = this.historyBatches.shift();
    return batch ?? { events: [], exhausted: true };
  }

  close(): void {
    this._handlers.clear();
  }
}
