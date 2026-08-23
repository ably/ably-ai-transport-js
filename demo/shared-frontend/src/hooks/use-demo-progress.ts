/**
 * useDemoProgress — given a demo's scenario list, derives which scenarios are
 * still unfinished from the conversation and the channel's raw messages, so
 * the suggestion chips stay in sync across clients via the channel-backed
 * history.
 *
 * A `Scenario` is the single source of truth for both the intro-card
 * walkthrough and the suggestion chips: the intro renders every scenario; the
 * chips render the trackable, still-unfinished ones. Completion is detected
 * by `id`:
 * - server-weather: a turn called getWeather without a preceding getLocation
 * - client-weather: a turn called getLocation
 * - approval-forecast: a turn produced a getWeatherForecast output (approved)
 * - retry-stock: a turn produced a getStockPrice output
 * - checklist: a turn produced an updateChecklist output (LiveObjects)
 * - multi-tab: more than one distinct run-client-id appears across
 *   ai-run-start messages
 * - regenerate: a wire message carries the msg-regenerate transport header
 * - edit: a wire message carries the fork-of transport header
 * - cancel: an ai-cancel event appears on the channel
 *
 * A scenario with no `id` (e.g. the Observability walkthrough entry) is shown
 * in the intro but never offered as a chip and never tracked.
 */

import { useMemo } from 'react';
import type * as Ably from 'ably';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import {
  EVENT_CANCEL,
  EVENT_RUN_START,
  getTransportHeaders,
  HEADER_FORK_OF,
  HEADER_MSG_REGENERATE,
  HEADER_RUN_CLIENT_ID,
} from '@ably/ai-transport';
import type { DemoStepId, Scenario } from '../lib/progress-steps';

/**
 * Filter a demo's scenarios down to the trackable ones still unfinished, in
 * the demo's own order. Drives the suggestion chips.
 */
export function useDemoProgress(
  scenarios: readonly Scenario[],
  messages: UIMessage[],
  ablyMessages: Ably.InboundMessage[],
): Scenario[] {
  return useMemo(() => {
    const completed = new Set<DemoStepId>();

    // Wire-level detections: cancel, regenerate, edit, and multi-tab all leave
    // a footprint on the channel's raw messages via event names and transport
    // headers, so they are visible to every client regardless of which one
    // performed the action.
    const runClientIds = new Set<string>();
    for (const m of ablyMessages) {
      if (m.name === EVENT_CANCEL) completed.add('cancel');
      const headers = getTransportHeaders(m);
      if (headers[HEADER_MSG_REGENERATE] !== undefined) completed.add('regenerate');
      if (headers[HEADER_FORK_OF] !== undefined) completed.add('edit');
      if (m.name === EVENT_RUN_START) {
        const runClientId = headers[HEADER_RUN_CLIENT_ID];
        if (runClientId !== undefined) runClientIds.add(runClientId);
      }
    }
    if (runClientIds.size > 1) completed.add('multi-tab');

    // Per-turn tool detections over the conversation: group each user message
    // with the assistant replies that follow it, and record which tools were
    // called and which produced an output within that turn.
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'user') continue;

      const turnTools = new Set<string>();
      const turnOutputs = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const m = messages[j];
        if (m.role === 'user') break;
        if (m.role !== 'assistant') continue;
        for (const part of m.parts) {
          if (!isToolUIPart(part)) continue;
          const toolName = getToolName(part);
          turnTools.add(toolName);
          if (part.state === 'output-available') {
            turnOutputs.add(toolName);
          }
        }
      }

      if (turnTools.has('getLocation')) completed.add('client-weather');
      if (turnOutputs.has('getWeather') && !turnTools.has('getLocation')) {
        completed.add('server-weather');
      }
      if (turnOutputs.has('getWeatherForecast')) completed.add('approval-forecast');
      if (turnOutputs.has('getStockPrice')) completed.add('retry-stock');
      if (turnOutputs.has('updateChecklist')) completed.add('checklist');
    }

    return scenarios.filter((s) => s.id !== undefined && !completed.has(s.id));
  }, [scenarios, messages, ablyMessages]);
}
