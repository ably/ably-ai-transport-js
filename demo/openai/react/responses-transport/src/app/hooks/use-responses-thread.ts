/**
 * useResponsesThread — the demo's conversation state, merged from the client
 * transport's event stream.
 *
 * Two sources, joined on a channel serial. `GET /api/messages` answers with the
 * conversation the server's store holds — already merged — plus the serial it
 * is complete up to. Those messages seed the merge, and then
 * `transport.history()` pages backwards only for the gap between that serial
 * and this client's own attach point (each call returns the next OLDER
 * chronological batch, so batches prepend and events at or before the seam are
 * dropped). Live events from `useTransportEvents` merge on top.
 *
 * The store is the producer for the messages it holds. Its watermark is a
 * lower bound rather than an exact seam, so the walk can re-return a message
 * the store already accounts for — and re-applying an output would duplicate
 * its text, because a decoder meeting a streamed message for the first time
 * emits everything accumulated so far as one delta. So an event's outputs are
 * dropped when the store already seeded that transport-message-id. Its inputs
 * still apply: a message body merges part-by-part with an equality dedupe, a
 * tool output dedupes by call-id, and an approval is last-writer-wins per
 * call, so applying one twice changes nothing.
 *
 * Events that arrive while the store read is still in flight are buffered and
 * merged after, so the merge's input stays in chronological order — which is
 * what lets a mid-run reload (the stored prompt plus a live continuation) come
 * out as one conversation.
 *
 * All merging goes through `createThreadMerge` (see `../lib/merge-thread.ts`);
 * this hook only owns the ordering and the React state.
 */

import { useClientTransport, useTransportEvents } from '@ably/ai-transport/react';
import type { TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createThreadMerge, type RunSummary, type ThreadMerge, type ThreadMessage } from '../lib/merge-thread';
import { serialOf } from '../lib/serial-of';
import type { StoredConversation } from '../lib/message-store';
import type { OpenAIInput } from '../lib/openai-thread';

/** Options for {@link useResponsesThread}. */
export interface UseResponsesThreadOptions {
  /** The conversation's channel name, passed to the messages endpoint. */
  channelName: string;
  /**
   * Called with each error the merge raises for an event it cannot apply (and
   * with a hydration failure). The event is skipped; merging continues.
   */
  onMergeError?: (error: unknown) => void;
}

/** What {@link useResponsesThread} returns. */
export interface ResponsesThreadHandle {
  /** The merged thread, oldest message first. */
  messages: ThreadMessage[];
  /** Every observed run's merged state, keyed by run-id. */
  runs: ReadonlyMap<string, RunSummary>;
  /** Whether the most recently active run is streaming. */
  isRunning: boolean;
  /** The run with the most recent lifecycle activity, or undefined before any run event. */
  activeRunId: string | undefined;
  /** False while the mount-time history hydration is still paging. */
  hydrated: boolean;
}

interface ThreadState {
  messages: ThreadMessage[];
  runs: ReadonlyMap<string, RunSummary>;
  isRunning: boolean;
  activeRunId: string | undefined;
  hydrated: boolean;
}

const emptyState = (): ThreadState => ({
  messages: [],
  runs: new Map(),
  isRunning: false,
  activeRunId: undefined,
  hydrated: false,
});

/**
 * Merge the enclosing provider's transport events into a linear thread.
 * @param options - See {@link UseResponsesThreadOptions}.
 * @returns The thread state; see {@link ResponsesThreadHandle}.
 */
export function useResponsesThread(options: UseResponsesThreadOptions): ResponsesThreadHandle {
  const { transport } = useClientTransport<OpenAIInput, OpenAIOutput>();
  const { channelName } = options;

  const mergeRef = useRef<ThreadMerge>(createThreadMerge());
  const bufferRef = useRef<TransportEvent<OpenAIInput, OpenAIOutput>[]>([]);
  const hydratedRef = useRef(false);
  /** Transport-message-ids the store seeded, so their outputs are not merged twice. */
  const seededIdsRef = useRef(new Set<string>());
  const onMergeErrorRef = useRef(options.onMergeError);
  useEffect(() => {
    onMergeErrorRef.current = options.onMergeError;
  });

  const [state, setState] = useState<ThreadState>(emptyState);

  const publish = useCallback((hydrated: boolean) => {
    const merge = mergeRef.current;
    setState({
      messages: merge.messages(),
      runs: merge.runs(),
      isRunning: merge.isRunning(),
      activeRunId: merge.activeRunId(),
      hydrated,
    });
  }, []);

  /**
   * The event as this merge should apply it, or `undefined` when there is
   * nothing left to apply. An event for a message the store seeded keeps its
   * inputs (which are idempotent) and loses its outputs (which would duplicate
   * the text the store already holds).
   */
  const forMerge = useCallback(
    (event: TransportEvent<OpenAIInput, OpenAIOutput>): TransportEvent<OpenAIInput, OpenAIOutput> | undefined => {
      if (event.kind !== 'message') return event;
      const id = event.meta.transportMessageId;
      if (id === undefined || !seededIdsRef.current.has(id)) return event;
      if (event.inputs.length === 0) return undefined;
      return { ...event, outputs: [] };
    },
    [],
  );

  const applyEvent = useCallback((event: TransportEvent<OpenAIInput, OpenAIOutput>) => {
    try {
      mergeRef.current.apply(event);
    } catch (error) {
      // A merge failure means the decoded sequence broke the merge's contract.
      // Skip the one event, surface it, and keep the thread alive. The console
      // is the fallback only: an app that handles onMergeError should not also
      // get noise it cannot suppress.
      const report = onMergeErrorRef.current;
      if (report) report(error);
      else console.error('[openai-demo] failed to merge transport event', error, event);
    }
  }, []);

  useTransportEvents<OpenAIInput, OpenAIOutput>((event) => {
    if (!hydratedRef.current) {
      bufferRef.current.push(event);
      return;
    }
    const forApply = forMerge(event);
    if (!forApply) return;
    applyEvent(forApply);
    publish(true);
  });

  useEffect(() => {
    if (!transport) return;
    let disposed = false;
    hydratedRef.current = false;
    bufferRef.current = [];
    seededIdsRef.current = new Set();
    mergeRef.current = createThreadMerge();
    publish(false);

    void (async () => {
      // The stored conversation and the live connection start together:
      // connect() is single-flight and idempotent, so this either joins the
      // provider's own connect or starts it.
      const [response] = await Promise.all([
        fetch(`/api/messages?channelName=${encodeURIComponent(channelName)}`),
        transport.connect(),
      ]);
      if (!response.ok) {
        throw new Error(`messages request failed with status ${String(response.status)}`);
      }
      // CAST: trust boundary — the response body is the demo's own messages
      // route's JSON, which serves the store verbatim.
      const seed = (await response.json()) as StoredConversation;
      if (disposed) return;

      const stored = seed.messages ?? [];
      const seam = seed.latestSerial;

      // Newer than the seam. An event with no serial is kept: only a locally
      // synthesised event lacks one, and history never carries those.
      const newerThanSeam = (event: TransportEvent<OpenAIInput, OpenAIOutput>): boolean => {
        if (seam === undefined) return true;
        const serial = serialOf(event);
        // Ably serials order lexicographically.
        return serial === undefined || serial > seam;
      };

      // The gap: everything published after the store's watermark, up to this
      // client's own attach point. Page backwards until a batch actually
      // contains an event at or before the seam — not until one is merely
      // shorter after filtering, which a serial-less event would also cause.
      const gap: TransportEvent<OpenAIInput, OpenAIOutput>[] = [];
      let exhausted = false;
      let reachedSeam = false;
      while (!exhausted && !reachedSeam && !disposed) {
        const batch = await transport.history();
        const fresh = batch.events.filter((event) => newerThanSeam(event));
        reachedSeam = batch.events.some((event) => !newerThanSeam(event));
        // Each batch is older than the previous one, so prepend.
        gap.unshift(...fresh);
        exhausted = batch.exhausted;
      }
      if (disposed) return;

      // The store's messages are already merged, so they are adopted rather
      // than replayed.
      mergeRef.current.seed({ messages: stored });
      seededIdsRef.current = new Set(stored.map((message) => message.transportMessageId));

      for (const event of gap) {
        const forApply = forMerge(event);
        if (forApply) applyEvent(forApply);
      }
      // The live buffer starts at this client's attach point, which is EARLIER
      // than the store read, so it can overlap what the walk covered.
      for (const event of bufferRef.current) {
        if (!newerThanSeam(event)) continue;
        const forApply = forMerge(event);
        if (forApply) applyEvent(forApply);
      }
      bufferRef.current = [];
      hydratedRef.current = true;
      publish(true);
    })().catch((error: unknown) => {
      if (disposed) return;
      const report = onMergeErrorRef.current;
      if (report) report(error);
      else console.error('[openai-demo] history hydration failed', error);
      // Unblock the UI with whatever the live stream delivers.
      for (const event of bufferRef.current) applyEvent(event);
      bufferRef.current = [];
      hydratedRef.current = true;
      publish(true);
    });

    return () => {
      disposed = true;
    };
  }, [transport, publish, applyEvent, forMerge, channelName]);

  return state;
}
