/**
 * Test fixtures shared by this demo's unit tests: WireMeta and classified
 * transport-event builders, plus a fake `ClientTransport` that records calls
 * and serves scripted history batches.
 */

import type {
  ClientTransport,
  PublishInputResult,
  SteerResult,
  TransportEvent,
  TransportHistoryResult,
  WireMeta,
} from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';
import type * as Ably from 'ably';
import type { UIMessage } from 'ai';

export type Event = TransportEvent<VercelInput, VercelOutput>;

/** Build a full WireMeta with every field defaulted; override what the test cares about. */
function makeMeta(overrides: Partial<WireMeta> = {}): WireMeta {
  return {
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
    parent: undefined,
    forkOf: undefined,
    regenerates: undefined,
    inputTransportMessageId: undefined,
    inputTransportMessageIds: undefined,
    steerTransportMessageIds: undefined,
    ...overrides,
  };
}

/** A classified `message` event carrying decoded inputs and/or outputs. */
export function messageEvent(
  meta: Partial<WireMeta>,
  content: { inputs?: VercelInput[]; outputs?: VercelOutput[] },
): Event {
  return {
    kind: 'message',
    meta: makeMeta(meta),
    inputs: content.inputs ?? [],
    outputs: content.outputs ?? [],
  };
}

/** A one-part user `{ kind: 'message' }` payload. */
export function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** A `message` event carrying one user-message input under a wire id. */
export function userEvent(wireId: string, domainId: string, text = 'hi'): Event {
  return messageEvent(
    { transportMessageId: wireId, role: 'user' },
    { inputs: [{ kind: 'message', payload: userMessage(domainId, text) }] },
  );
}

/** A run-lifecycle `end` event for a run. */
export function runEndEvent(runId: string): Event {
  return {
    kind: 'run-lifecycle',
    event: { type: 'end', runId, clientId: 'agent', invocationId: '', serial: 'serial-end', reason: 'complete' },
  };
}

/**
 * A fake `ClientTransport` for driving the hydration path under test: records
 * `publishInput` and `cancel` calls, serves scripted history batches, and
 * exposes {@link emit} so a test can push classified events into the
 * subscription like the channel would.
 */
export class FakeClientTransport implements ClientTransport<VercelInput, VercelOutput> {
  /** Scripted history batches, served in order; further calls return an exhausted empty batch. */
  historyBatches: TransportHistoryResult<VercelInput, VercelOutput>[] = [];
  /** How many times history() was called. */
  historyCount = 0;

  private readonly _handlers = new Set<(event: Event) => void>();
  private readonly _ablyMessageHandlers = new Set<(message: Ably.InboundMessage) => void>();
  private _publishCount = 0;

  /** Deliver a raw wire message to every `ably-message` subscriber, like the channel would. */
  emitAblyMessage(serial: string): void {
    // CAST: the watermark path reads only `serial`.
    const message = { serial } as Ably.InboundMessage;
    for (const handler of this._ablyMessageHandlers) handler(message);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(handler: (event: Event) => void): () => void {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  on(event: 'event', handler: (e: Event) => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'error', handler: (err: Ably.ErrorInfo) => void): () => void;
  on(event: string, handler: (payload: never) => void): () => void {
    if (event !== 'ably-message') return () => undefined;
    // CAST: the overload above binds `ably-message` to an InboundMessage handler.
    const listener = handler as unknown as (message: Ably.InboundMessage) => void;
    this._ablyMessageHandlers.add(listener);
    return () => this._ablyMessageHandlers.delete(listener);
  }

  publishInput(): Promise<PublishInputResult> {
    this._publishCount += 1;
    return Promise.resolve({
      transportMessageId: `cm-${String(this._publishCount)}`,
      eventId: `ev-${String(this._publishCount)}`,
      // Left pending on purpose: the chat transport resolves the run id off
      // the channel, so nothing in these tests awaits this.
      runId: new Promise<string>(() => undefined),
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  steer(): SteerResult {
    throw new Error('steer is not used by this demo');
  }

  history(): Promise<TransportHistoryResult<VercelInput, VercelOutput>> {
    const batch = this.historyBatches[this.historyCount] ?? { events: [], exhausted: true };
    this.historyCount += 1;
    return Promise.resolve(batch);
  }

  close(): void {
    this._handlers.clear();
  }
}
