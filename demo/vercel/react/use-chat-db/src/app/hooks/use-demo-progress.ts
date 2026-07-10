/**
 * useDemoProgress — given this demo's scenario list, derives which scenarios are
 * still unfinished from the linear conversation, so the suggestion chips stay in
 * sync across clients via the channel-backed history.
 *
 * Completion is detected by scenario id from a plain `useChat` message list:
 * - server-weather: a turn called getWeather without a preceding getLocation
 * - client-weather: a turn called getLocation
 * - approval-forecast: a turn produced a getWeatherForecast output (approved)
 * - cancel: an ai-cancel event appears in the raw Ably messages
 *
 * This demo renders a linear `useChat` message list (no branch navigation), so
 * there is no per-message Run/branch metadata; the multi-tab, edit, and
 * regenerate scenarios the branching `use-chat` demo tracks do not apply here,
 * and the shared view-based `useDemoProgress` (which reads branch/run lookups)
 * cannot be used. Intro-only scenarios (no `id`, e.g. Observability) are shown
 * in the intro card but never offered as a chip or tracked.
 */

import { useMemo } from 'react';
import type * as Ably from 'ably';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { EVENT_CANCEL } from '@ably/ai-transport';
import type { DemoStepId, Scenario } from '@ably-ai-demos/frontend';

export function useDemoProgress(
  scenarios: readonly Scenario[],
  messages: UIMessage[],
  ablyMessages: Ably.InboundMessage[],
): Scenario[] {
  return useMemo(() => {
    const completed = new Set<DemoStepId>();

    if (ablyMessages.some((m) => m.name === EVENT_CANCEL)) {
      completed.add('cancel');
    }

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
      if (turnOutputs.has('getWeatherForecast')) {
        completed.add('approval-forecast');
      }
    }

    return scenarios.filter((s) => s.id !== undefined && !completed.has(s.id));
  }, [scenarios, messages, ablyMessages]);
}
