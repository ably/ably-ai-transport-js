/**
 * The demo's own instrumentation of the durable activities, shared between the
 * server (each activity reports its lifecycle — see `withActivity` in
 * `workflows/activity-runtime.ts`) and the client (the WDK processes panel
 * renders it). This is demo instrumentation, not a WDK-native feed: WDK has no
 * push subscription for activity lifecycle, so each activity reports its own
 * start/finish over a sidecar Ably channel. The panel enriches it with
 * authoritative per-run status polled from the real WDK observability API (see
 * `api/wdk/runs`).
 */

/** Which activity of the durable turn this event describes. */
export type ActivityKind = 'open' | 'inference' | 'tool' | 'terminal' | 'cleanup';

/** The activity's lifecycle phase: it just started, or it finished. A throw emits nothing — the panel infers a dead attempt from a stuck `running` superseded by a later attempt. */
export type ActivityPhase = 'running' | 'done';

/** One lifecycle report published by an activity to the sidecar channel. */
export interface ActivityEvent {
  /** Which activity of the turn (open / inference / tool / cleanup). */
  kind: ActivityKind;
  /** running when the activity starts; done when it returns normally. */
  phase: ActivityPhase;
  /** The WDK workflow run id (`getWorkflowMetadata().workflowRunId`) — groups a turn's activities. */
  workflowRunId: string;
  /** The WDK step id (`getStepMetadata().stepId`) — stable across retries of this activity. */
  wdkStepId: string;
  /** The WDK attempt number (1-based; bumps when WDK retries the activity). */
  attempt: number;
  /** The AIT run id this activity is driving, once known — the panel's correlation to the conversation. */
  aitRunId?: string;
  /** Millisecond timestamp stamped by the activity's process. */
  ts: number;
}

/** The Ably event name used for activity lifecycle messages on the sidecar channel. */
export const WDK_ACTIVITY_EVENT = 'activity';

/**
 * The sidecar channel carrying activity telemetry for a conversation, derived
 * from the chat channel so it sits within the same token-capability
 * namespace. Kept separate from the chat channel so it never decodes as AIT
 * conversation traffic.
 * @param channelName - The conversation's chat channel name.
 * @returns The sidecar channel name.
 */
export function wdkActivityChannel(channelName: string): string {
  return `${channelName}:wdk`;
}
