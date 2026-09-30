/** Fold decoded AG-UI events through AG-UI's own client reducer. */

import { AbstractAgent } from '@ag-ui/client';
import type * as AGUI from '@ag-ui/core';
import { from, type Observable } from 'rxjs';

import type { AGUIEvent } from '../../src/ag-ui/index.js';

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
 * Fold one run's events through AG-UI's reducer and return the messages it
 * builds. The codec's own `run-input` is left out, since the reducer takes
 * AG-UI's events only. The pipeline is strict: a stream that does not open with
 * `RUN_STARTED`, a delta for a message that never started, or a tool chunk
 * stream with no `toolCallName` rejects. So folding through it proves a
 * decoded sequence is one AG-UI's own machinery accepts.
 * @param events - The run's events, in wire order.
 * @param initialMessages - The messages the client already holds, as it loads them from its store.
 * @returns The agent's messages after the run.
 */
export const foldWithAGUIReducer = async (
  events: AGUIEvent[],
  initialMessages: AGUI.Message[] = [],
): Promise<AGUI.Message[]> => {
  const run = events.filter((e): e is AGUI.Event => e.type !== 'run-input');
  const agent = new ReplayAgent(run, initialMessages);
  await agent.runAgent();
  return agent.messages;
};
