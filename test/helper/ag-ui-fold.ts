/** Merge decoded AG-UI events with AG-UI's own client reducer. */

import { AbstractAgent } from '@ag-ui/client';
import type * as AGUI from '@ag-ui/core';
import { from, type Observable } from 'rxjs';

/**
 * An agent whose run replays a fixed list of events, so `runAgent()` passes
 * them through AG-UI's own pipeline: `transformChunks`, `verifyEvents` and
 * the reducer that builds `messages`.
 */
class ReplayAgent extends AbstractAgent {
  private readonly _events: AGUI.BaseEvent[];

  constructor(events: AGUI.BaseEvent[], initialMessages: AGUI.Message[]) {
    super({ threadId: 'th1', initialMessages });
    this._events = events;
  }

  run(): Observable<AGUI.BaseEvent> {
    return from(this._events);
  }
}

/**
 * Merge one run's events with AG-UI's reducer and return the messages it
 * builds. The pipeline is strict: a stream that does not open with
 * `RUN_STARTED`, a delta for a message that never started, or a tool chunk
 * stream without a `toolCallName` rejects. So a run that merges without an
 * error proves that AG-UI's own pipeline accepts the decoded sequence.
 * @param events - The run's events, in wire order.
 * @param initialMessages - The messages the client already holds, as it loads them from its store.
 * @returns The agent's messages after the run.
 */
export const foldWithAGUIReducer = async (
  events: AGUI.Event[],
  initialMessages: AGUI.Message[] = [],
): Promise<AGUI.Message[]> => {
  const agent = new ReplayAgent(events, initialMessages);
  await agent.runAgent();
  return agent.messages;
};
