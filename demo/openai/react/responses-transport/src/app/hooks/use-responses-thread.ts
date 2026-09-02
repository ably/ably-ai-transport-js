/**
 * useResponsesThread — the demo's conversation state, merged from the client
 * transport's event stream.
 *
 * On mount it hydrates from the messages endpoint (`GET /api/messages`), which
 * returns the conversation the server's store holds: already-merged messages
 * and runs. Those seed the merge, so nothing already merged is merged again.
 * Nothing pages channel history — the store is the whole record, and the only
 * other source is the live subscription.
 *
 * Live events for a run the store already holds are skipped. The agent stores
 * a run when it is over, so those events are accounted for; merging them again
 * would build a second copy of the same reply under the wire's own
 * transport-message-id. Everything else merges on top, and events that arrive
 * while the store read is still in flight are buffered and merged after, so
 * the merge's input stays in chronological order — which is what lets a
 * mid-run reload (the stored prompt plus a live continuation) come out as one
 * conversation.
 *
 * All merging goes through `createThreadMerge` (see `../lib/merge-thread.ts`);
 * this hook only owns the ordering and the React state.
 */

import { useClientTransport, useTransportEvents } from '@ably/ai-transport/react';
import type { TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createThreadMerge, type RunSummary, type ThreadMerge, type ThreadMessage } from '../lib/merge-thread';
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
  /** Runs the store already accounts for, so their live events are not merged twice. */
  const storedRunsRef = useRef(new Set<string>());
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
   * Whether an event belongs to a run the store already holds. The agent
   * stores a run when it is over, so anything under such a run-id is already
   * merged; merging it again would build a second copy of the same reply.
   */
  const isStoredRun = useCallback((event: TransportEvent<OpenAIInput, OpenAIOutput>): boolean => {
    const runId = event.kind === 'message' ? event.meta.runId : event.event.runId;
    return runId !== undefined && storedRunsRef.current.has(runId);
  }, []);

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
    if (isStoredRun(event)) return;
    applyEvent(event);
    publish(true);
  });

  useEffect(() => {
    if (!transport) return;
    let disposed = false;
    hydratedRef.current = false;
    bufferRef.current = [];
    storedRunsRef.current = new Set();
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

      // The store's messages are already merged, so they are adopted rather
      // than replayed.
      mergeRef.current.seed({ messages: seed.messages ?? [], runs: seed.runs ?? [] });
      storedRunsRef.current = new Set((seed.runs ?? []).map(([runId]) => runId));
      // The buffer started at this client's attach point, so it can hold events
      // of a run the store already covers. Those are already merged.
      for (const event of bufferRef.current) {
        if (!isStoredRun(event)) applyEvent(event);
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
  }, [transport, publish, applyEvent, isStoredRun, channelName]);

  return state;
}
