/**
 * Channel-history helpers the activities share.
 *
 * Each activity is a fresh process bounded at its own channel attach point, so
 * everything it knows about the conversation comes from paging
 * `AgentTransport.history()` backwards to exhaustion. The collected events
 * serve two reads: the run-lifecycle gate (is this run still ours to drive?)
 * and the message fold (`foldMessages`) for model context and pending-tool
 * classification.
 */

import type { AgentTransport, RunLifecycleEvent } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';

import type { WdkTransportEvent } from '../lib/fold-messages';

/** The Vercel-codec agent transport every activity runs against. */
export type WdkAgentTransport = AgentTransport<VercelInput, VercelOutput>;

/**
 * Page the channel's history backwards to exhaustion and return every
 * classified event in chronological (oldest-first) order.
 * @param transport - A connected agent transport.
 * @returns All events up to the transport's attach point.
 */
export async function collectHistory(transport: {
  history: WdkAgentTransport['history'];
}): Promise<WdkTransportEvent[]> {
  let all: WdkTransportEvent[] = [];
  for (;;) {
    const batch = await transport.history();
    all = [...batch.events, ...all];
    if (batch.exhausted) return all;
  }
}

/**
 * The run's latest lifecycle event in the collected history — the gate every
 * re-entering activity folds before publishing anything. `undefined` means the
 * run's opening event is not visible yet (a paging/propagation artefact, not a
 * fact about the run); the caller decides what a miss means for its retry
 * semantics.
 * @param events - Collected events, oldest first.
 * @param runId - The run to classify.
 * @returns The latest lifecycle event for the run, or undefined.
 */
export function latestRunLifecycle(events: WdkTransportEvent[], runId: string): RunLifecycleEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'run-lifecycle' && event.event.runId === runId) return event.event;
  }
  return undefined;
}
