/**
 * useDemoProgress — given this demo's scenario list, derives which scenarios are
 * still unfinished from the folded thread, so the suggestion chips stay in
 * sync across clients via the channel-backed history.
 *
 * A `Scenario` is the single source of truth for both the intro-card walkthrough
 * and the chips: the intro renders every scenario; the chips render the
 * trackable, still-unfinished ones. A scenario with no `id` is shown in the
 * intro but never tracked and never offered as a chip.
 *
 * Completion detected from the folded thread:
 * - server-weather: the getWeather tool ran (a getWeather function_call paired
 *   with its function_call_output). A tool run splits its work across separate
 *   messages, so the call and its output are paired across turns, not within one.
 * - client-weather: the getLocation client tool ran (a function_call paired
 *   with a client-published function_call_output)
 * - approval-forecast: a getWeatherForecast call reached a decision (its
 *   per-call state carries an approval, or its output is present)
 * - multi-tab: more than one distinct publisher clientId appears across user turns
 * - cancel: a cancel signal was seen on the channel
 *
 * The Observability scenario is local UI state, so it carries no `id` and is not
 * tracked here.
 */

import { useMemo } from 'react';
import type * as Ably from 'ably';
import { EVENT_CANCEL } from '@ably/ai-transport';
import type { OpenAIMessage } from '../lib/openai-thread';
import type { DemoStepId, Scenario } from '@ably-ai-demos/frontend/lib/progress-steps';

import type { ThreadMessage } from '../lib/fold-thread';

/**
 * Whether the named tool ran — a function_call for it paired with its
 * function_call_output. A tool run splits its work across separate messages, so
 * the call and its output are collected across all turns (mirroring the
 * render-time pairing in display.ts), not within a single turn.
 */
function ranTool(turns: OpenAIMessage[], name: string): boolean {
  const callIds = new Set<string>();
  const outputCallIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'function_call' && item.name === name) callIds.add(item.call_id);
      else if (item.type === 'function_call_output') outputCallIds.add(item.call_id);
    }
  }
  for (const callId of callIds) if (outputCallIds.has(callId)) return true;
  return false;
}

/**
 * Whether a getWeatherForecast call reached an approval decision — its per-call
 * state records the user's decision, or its output is present (an approved
 * run's forecast, or a denial's rejection). `'pending'` does not count — the
 * fold sets it the moment the request lands, so treating it as decided would
 * retire the chip before the user has clicked anything. Collected across all
 * turns, since a call and its output or state can be split across messages.
 */
function decidedForecast(turns: OpenAIMessage[]): boolean {
  if (ranTool(turns, 'getWeatherForecast')) return true;
  for (const turn of turns) {
    const states = turn.toolCallStates ?? {};
    for (const item of turn.items) {
      if (item.type !== 'function_call' || item.name !== 'getWeatherForecast') continue;
      const approval = states[item.call_id]?.approval;
      if (approval === 'approved' || approval === 'denied') return true;
    }
  }
  return false;
}

/**
 * Filter this demo's scenarios down to the trackable ones still unfinished, in
 * the demo's own order. Drives the suggestion chips. Reruns when the folded
 * thread or channel messages change.
 * @param scenarios - The demo's scenarios; only those with an `id` are trackable.
 * @param messages - The folded thread.
 * @param ablyMessages - Raw channel messages, for detecting a cancel signal.
 * @returns The scenarios not yet demonstrated, in the demo's order.
 */
export function useDemoProgress(
  scenarios: readonly Scenario[],
  messages: ThreadMessage[],
  ablyMessages: Ably.InboundMessage[],
): Scenario[] {
  return useMemo(() => {
    const completed = new Set<DemoStepId>();

    if (ablyMessages.some((m) => m.name === EVENT_CANCEL)) completed.add('cancel');

    if (ranTool(messages, 'getWeather')) completed.add('server-weather');
    if (ranTool(messages, 'getLocation')) completed.add('client-weather');
    if (decidedForecast(messages)) completed.add('approval-forecast');

    const userClientIds = new Set<string>();
    for (const message of messages) {
      if (message.role === 'user' && message.clientId !== undefined) userClientIds.add(message.clientId);
    }
    if (userClientIds.size > 1) completed.add('multi-tab');

    return scenarios.filter((s) => s.id !== undefined && !completed.has(s.id));
  }, [scenarios, messages, ablyMessages]);
}
