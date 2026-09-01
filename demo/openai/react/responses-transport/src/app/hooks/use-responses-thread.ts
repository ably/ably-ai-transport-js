/**
 * useResponsesThread — the demo's conversation state, merged from the client
 * transport's event stream.
 *
 * On mount it hydrates from the messages endpoint (`GET /api/messages`), which
 * returns the conversation's decoded events plus the serial of the newest one
 * — the seam. The hook merges those events, then pages `transport.history()`
 * backwards only for the gap between the seam and its own live attach point
 * (each call returns the next OLDER chronological batch, so batches prepend
 * and events at or before the seam are dropped), then merges live events from
 * `useTransportEvents`. Live events that arrive while hydration is still in
 * flight are buffered and merged after, keeping the merge's input in
 * chronological order — that ordering is what lets a mid-run reload (partial
 * history plus a live continuation) merge to one message. All merging goes
 * through `createThreadMerge` (see `../lib/merge-thread.ts`); this hook only
 * owns the ordering and the React state.
 */

import { useClientTransport, useTransportEvents } from '@ably/ai-transport/react';
import type { TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createThreadMerge, type RunSummary, type ThreadMerge, type ThreadMessage } from '../lib/merge-thread';
import { type ExistingMessages, serialOf } from '../lib/get-existing-messages';

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
  const { transport } = useClientTransport<unknown, OpenAIOutput>();
  const { channelName } = options;

  const mergeRef = useRef<ThreadMerge>(createThreadMerge());
  const bufferRef = useRef<TransportEvent<unknown, OpenAIOutput>[]>([]);
  const hydratedRef = useRef(false);
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

  const applyEvent = useCallback((event: TransportEvent<unknown, OpenAIOutput>) => {
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

  useTransportEvents<unknown, OpenAIOutput>((event) => {
    if (!hydratedRef.current) {
      bufferRef.current.push(event);
      return;
    }
    applyEvent(event);
    publish(true);
  });

  useEffect(() => {
    if (!transport) return;
    let disposed = false;
    hydratedRef.current = false;
    bufferRef.current = [];
    mergeRef.current = createThreadMerge();
    publish(false);

    void (async () => {
      // The stored conversation and the live connection race in parallel:
      // connect() is single-flight and idempotent, so this either joins the
      // provider's own connect or starts it — history() requires it first.
      const [response] = await Promise.all([
        fetch(`/api/messages?channelName=${encodeURIComponent(channelName)}`),
        transport.connect(),
      ]);
      if (!response.ok) {
        throw new Error(`messages request failed with status ${String(response.status)}`);
      }
      // CAST: trust boundary — the response body is the demo's own messages route's JSON.
      const seed = (await response.json()) as Pick<ExistingMessages, 'events' | 'latestSerial'>;
      const seam = seed.latestSerial;

      // Newer than the seam. An event with no serial is kept: only a locally
      // synthesised event lacks one, and the seed never carries those, so it
      // cannot be a duplicate of anything already applied.
      const newerThanSeam = (event: TransportEvent<unknown, OpenAIOutput>): boolean => {
        if (seam === undefined) return true;
        const serial = serialOf(event);
        // Ably serials order lexicographically.
        return serial === undefined || serial > seam;
      };

      // The gap: everything the endpoint's read did not cover, up to this
      // client's own attach point. Page backwards until a batch actually
      // contains an event at or before the seam — not until one is merely
      // shorter after filtering, which a serial-less event would also cause.
      const gap: TransportEvent<unknown, OpenAIOutput>[] = [];
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
      for (const event of seed.events) applyEvent(event);
      for (const event of gap) applyEvent(event);
      // The live buffer starts at this client's attach point, which is EARLIER
      // than the endpoint read's own attach — the two connects race. Anything
      // the seed already covered has to be filtered out here too, or the
      // overlap is applied twice.
      for (const event of bufferRef.current) {
        if (newerThanSeam(event)) applyEvent(event);
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
  }, [transport, publish, applyEvent, channelName]);

  return state;
}
