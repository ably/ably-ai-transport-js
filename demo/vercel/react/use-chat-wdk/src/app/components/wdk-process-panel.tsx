'use client';

import { ChannelProvider, useChannel } from 'ably/react';
import { useEffect, useState } from 'react';

import { type ActivityEvent, wdkActivityChannel } from '../lib/wdk-activity';
import { shortId } from '../lib/short-id';

/** Real WDK-side status of one workflow run, polled from `api/wdk/runs`. */
interface WdkRunInfo {
  workflowRunId: string;
  status: string;
}

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
  open: 'open',
  inference: 'inference',
  tool: 'tool',
  terminal: 'terminal',
  cleanup: 'cleanup',
};

function phaseColor(phase: ActivityEvent['phase']): string {
  return phase === 'running' ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500';
}

// Emerald / amber / red carry the run-status semantics (done, in-flight,
// failed); only the neutral fallback maps to a shadcn token. Each accent is a
// raw palette colour (not a theme token), so it carries explicit light (soft
// tint + deep text) and dark (deep bg + bright text) shades.
function statusColor(status: string | undefined): string {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400';
  if (status === 'running' || status === 'pending')
    return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400';
  if (status === 'failed' || status === 'cancelled') return 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400';
  return 'bg-muted text-muted-foreground';
}

function ActivityRow({ event, died }: { event: ActivityEvent; died: boolean }) {
  return (
    <div
      className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-[11px]"
      title={died ? 'this attempt died mid-activity; WDK retried it as a fresh process' : undefined}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${died ? 'bg-red-500' : phaseColor(event.phase)}`} />
      <span className="w-16 shrink-0 font-medium text-foreground">{KIND_LABEL[event.kind]}</span>
      {died && (
        <span className="shrink-0 rounded bg-red-100 px-1 text-[10px] text-red-700 dark:bg-red-950 dark:text-red-400">
          died
        </span>
      )}
      {event.attempt > 1 && (
        <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-400">
          attempt {event.attempt}
        </span>
      )}
      <span
        className="truncate font-mono text-muted-foreground"
        title={event.wdkStepId}
      >
        step {shortId(event.wdkStepId)}
      </span>
      {event.aitRunId && (
        <span
          className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
          title={`AIT run ${event.aitRunId}`}
        >
          run {shortId(event.aitRunId)}
        </span>
      )}
    </div>
  );
}

export function WdkProcessPanel({ channelName }: { channelName: string }) {
  // ably/react's channel hooks require a ChannelProvider for the exact channel.
  // The sidecar telemetry channel is separate from the chat channel the AIT
  // provider already wraps the subtree in, so provide it here.
  return (
    <ChannelProvider channelName={wdkActivityChannel(channelName)}>
      <WdkProcessPanelInner channelName={channelName} />
    </ChannelProvider>
  );
}

function WdkProcessPanelInner({ channelName }: { channelName: string }) {
  // Sidecar activity feed — our own instrumentation. Key by attempt so a WDK
  // retry of a step shows as a distinct row (attempt 1 stuck "running", attempt 2
  // "done") rather than overwriting the crashed attempt.
  const [activities, setActivities] = useState<ActivityEvent[]>([]);

  useChannel(wdkActivityChannel(channelName), (message) => {
    // CAST: sidecar wire data — this channel only carries our own ActivityEvent
    // publishes (see makeEmit in workflows/activities.ts).
    const event = message.data as ActivityEvent;
    setActivities((prev) => {
      const keyOf = (e: ActivityEvent): string => `${e.workflowRunId}:${e.wdkStepId}:${String(e.attempt)}`;
      const index = prev.findIndex((e) => keyOf(e) === keyOf(event));
      if (index === -1) return [...prev, event];
      // Keep the terminal phase: don't let a late "running" overwrite a "done".
      if (prev[index].phase !== 'running' && event.phase === 'running') return prev;
      const next = [...prev];
      next[index] = event;
      return next;
    });
  });

  // Enrich each known workflow run with authoritative WDK-side status.
  const [realRuns, setRealRuns] = useState<Record<string, WdkRunInfo>>({});
  const workflowIds = [...new Set(activities.map((a) => a.workflowRunId))];
  const idsKey = workflowIds.join(',');

  useEffect(() => {
    if (!idsKey) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/wdk/runs?ids=${encodeURIComponent(idsKey)}`);
        if (!res.ok || cancelled) return;
        // CAST: our own /api/wdk/runs response shape (trust boundary — parsed JSON).
        const data = (await res.json()) as { runs: WdkRunInfo[] };
        if (cancelled) return;
        setRealRuns(Object.fromEntries(data.runs.map((r) => [r.workflowRunId, r])));
      } catch {
        // Best-effort enrichment; the sidecar feed carries the live view.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [idsKey]);

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col border-l border-border bg-background">
      <div className="border-b border-border px-3 py-3">
        <div className="text-sm font-medium text-foreground">WDK processes</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Workflows &amp; activities, correlated to AIT run ids
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {workflowIds.length === 0 && (
          <div className="text-[11px] text-muted-foreground">
            Send a message — each turn runs as a workflow whose activities appear here.
          </div>
        )}
        {workflowIds.map((workflowRunId) => {
          const real = realRuns[workflowRunId];
          const events = activities.filter((a) => a.workflowRunId === workflowRunId).sort((a, b) => a.ts - b.ts);
          // A crashed attempt never reports a terminal phase (its process died),
          // so a still-"running" row with a later attempt of the same activity
          // is rendered as dead rather than left pulsing forever.
          const latestAttempt = new Map<string, number>();
          for (const e of events) {
            latestAttempt.set(e.wdkStepId, Math.max(latestAttempt.get(e.wdkStepId) ?? 0, e.attempt));
          }
          return (
            <div
              key={workflowRunId}
              className="rounded-lg border border-border bg-card p-2"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  title={workflowRunId}
                >
                  wf {shortId(workflowRunId)}
                </span>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${statusColor(real?.status)}`}>
                  WDK: {real?.status ?? '—'}
                </span>
              </div>
              <div className="space-y-1">
                {events.map((event) => (
                  <ActivityRow
                    key={`${event.wdkStepId}:${String(event.attempt)}`}
                    event={event}
                    died={
                      event.phase === 'running' && event.attempt < (latestAttempt.get(event.wdkStepId) ?? event.attempt)
                    }
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-border px-3 py-2 text-[10px] leading-tight text-muted-foreground">
        Dots &amp; rows are demo instrumentation; the <span className="text-foreground">WDK</span> status is polled from
        the real Workflow observability API.
      </div>
    </aside>
  );
}
