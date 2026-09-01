/**
 * useResponsesThread — the demo's conversation state, folded from the client
 * transport's event stream.
 *
 * On mount it hydrates by paging `transport.history()` to exhaustion (each
 * call returns the next OLDER chronological batch, so batches prepend), then
 * folds live events from `useTransportEvents`. Live events that arrive while
 * hydration is still paging are buffered and folded after the history, keeping
 * the fold's input in chronological order — that ordering is what lets a
 * mid-run reload (partial history plus a live continuation) fold to one
 * message. All folding goes through `createThreadFold` (see
 * `../lib/fold-thread.ts`); this hook only owns the ordering and the React
 * state.
 */

import { useClientTransport, useTransportEvents } from '@ably/ai-transport/react';
import type { TransportEvent } from '@ably/ai-transport';
import type { OpenAIInput, OpenAIOutput } from '@ably/ai-transport/openai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createThreadFold, type RunSummary, type ThreadFold, type ThreadMessage } from '../lib/fold-thread';

/** Options for {@link useResponsesThread}. */
export interface UseResponsesThreadOptions {
  /**
   * Called with each error the fold raises for an event it cannot apply (and
   * with a hydration paging failure). The event is skipped; folding continues.
   */
  onFoldError?: (error: unknown) => void;
}

/** What {@link useResponsesThread} returns. */
export interface ResponsesThreadHandle {
  /** The folded thread, oldest message first. */
  messages: ThreadMessage[];
  /** Every observed run's folded state, keyed by run-id. */
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
 * Fold the enclosing provider's transport events into a linear thread.
 * @param options - See {@link UseResponsesThreadOptions}.
 * @returns The thread state; see {@link ResponsesThreadHandle}.
 */
export function useResponsesThread(options: UseResponsesThreadOptions = {}): ResponsesThreadHandle {
  const { transport } = useClientTransport<OpenAIInput, OpenAIOutput>();

  const foldRef = useRef<ThreadFold>(createThreadFold());
  const bufferRef = useRef<TransportEvent<OpenAIInput, OpenAIOutput>[]>([]);
  const hydratedRef = useRef(false);
  const onFoldErrorRef = useRef(options.onFoldError);
  useEffect(() => {
    onFoldErrorRef.current = options.onFoldError;
  });

  const [state, setState] = useState<ThreadState>(emptyState);

  const publish = useCallback((hydrated: boolean) => {
    const fold = foldRef.current;
    setState({
      messages: fold.messages(),
      runs: fold.runs(),
      isRunning: fold.isRunning(),
      activeRunId: fold.activeRunId(),
      hydrated,
    });
  }, []);

  const applyEvent = useCallback((event: TransportEvent<OpenAIInput, OpenAIOutput>) => {
    try {
      foldRef.current.apply(event);
    } catch (error) {
      // A fold failure means the decoded sequence broke the fold's contract.
      // Skip the one event, surface it, and keep the thread alive. The console
      // is the fallback only: an app that handles onFoldError should not also
      // get noise it cannot suppress.
      const report = onFoldErrorRef.current;
      if (report) report(error);
      else console.error('[openai-demo] failed to fold transport event', error, event);
    }
  }, []);

  useTransportEvents<OpenAIInput, OpenAIOutput>((event) => {
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
    foldRef.current = createThreadFold();
    publish(false);

    void (async () => {
      // connect() is single-flight and idempotent, so this either joins the
      // provider's own connect or starts it — history() requires it first.
      await transport.connect();
      const events: TransportEvent<OpenAIInput, OpenAIOutput>[] = [];
      let exhausted = false;
      while (!exhausted && !disposed) {
        const batch = await transport.history();
        // Each batch is older than the previous one, so prepend.
        events.unshift(...batch.events);
        exhausted = batch.exhausted;
      }
      if (disposed) return;
      for (const event of events) applyEvent(event);
      for (const event of bufferRef.current) applyEvent(event);
      bufferRef.current = [];
      hydratedRef.current = true;
      publish(true);
    })().catch((error: unknown) => {
      if (disposed) return;
      const report = onFoldErrorRef.current;
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
  }, [transport, publish, applyEvent]);

  return state;
}
