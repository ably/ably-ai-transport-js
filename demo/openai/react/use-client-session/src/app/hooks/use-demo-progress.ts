/**
 * useDemoProgress — given this demo's scenario list, derives which scenarios are
 * still unfinished from the conversation tree, so the suggestion chips stay in
 * sync across clients via the channel-backed history.
 *
 * A `Scenario` is the single source of truth for both the intro-card walkthrough
 * and the chips: the intro renders every scenario; the chips render the
 * trackable, still-unfinished ones. A scenario with no `id` is shown in the
 * intro but never tracked and never offered as a chip.
 *
 * Completion detected from tree state:
 * - server-weather: the getWeather tool ran (a getWeather function_call paired
 *   with its function_call_output). A tool run splits its work across separate
 *   messages, so the call and its output are paired across turns, not within one.
 * - multi-tab: more than one distinct turn-client-id appears across turns
 * - regenerate: any assistant node has siblings (forked via Regenerate)
 * - edit: any user node has siblings (forked via Edit)
 * - cancel: a cancel signal was seen on the channel
 *
 * Client-side tools and approval-gated tools are not part of this demo yet, so
 * (unlike the Vercel demo) there are no chips for them. The Observability
 * scenario is local UI state, so it carries no `id` and is not tracked here.
 */

import { useMemo } from 'react';
import type * as Ably from 'ably';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { EVENT_CANCEL } from '@ably/ai-transport';
import type { OpenAIMessage } from '@ably/ai-transport/openai';
import type { DemoStepId, Scenario } from '@ably-ai-demos/frontend/lib/progress-steps';

/**
 * Whether the getWeather tool ran — a getWeather function_call paired with its
 * function_call_output. A tool run splits its work across separate messages, so
 * the call and its output are collected across all turns (mirroring the
 * render-time pairing in helpers.ts), not within a single turn.
 */
function ranServerWeather(turns: OpenAIMessage[]): boolean {
  const weatherCallIds = new Set<string>();
  const outputCallIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'function_call' && item.name === 'getWeather') weatherCallIds.add(item.call_id);
      else if (item.type === 'function_call_output') outputCallIds.add(item.call_id);
    }
  }
  for (const callId of weatherCallIds) if (outputCallIds.has(callId)) return true;
  return false;
}

/**
 * Filter this demo's scenarios down to the trackable ones still unfinished, in
 * the demo's own order. Drives the suggestion chips. Reruns when the visible
 * turns, branch state, run lookup, or channel messages change.
 * @param scenarios - The demo's scenarios; only those with an `id` are trackable.
 * @param messages - The visible turns paired with their codec-message-ids.
 * @param branchSelection - Branch handle lookup, for detecting forked (edited/regenerated) nodes.
 * @param runOf - Run lookup, for the client id that owns each turn.
 * @param ablyMessages - Raw channel messages, for detecting a cancel signal.
 * @returns The scenarios not yet demonstrated, in the demo's order.
 */
export function useDemoProgress(
  scenarios: readonly Scenario[],
  messages: CodecMessage<OpenAIMessage>[],
  branchSelection: (codecMessageId: string) => BranchHandle<OpenAIMessage>,
  runOf: (codecMessageId: string) => RunInfo | undefined,
  ablyMessages: Ably.InboundMessage[],
): Scenario[] {
  return useMemo(() => {
    const completed = new Set<DemoStepId>();

    if (ablyMessages.some((m) => m.name === EVENT_CANCEL)) completed.add('cancel');

    if (ranServerWeather(messages.map(({ message }) => message))) completed.add('server-weather');

    const turnClientIds = new Set<string>();
    for (const { codecMessageId } of messages) {
      const run = runOf(codecMessageId);
      if (run?.clientId) turnClientIds.add(run.clientId);
    }
    if (turnClientIds.size > 1) completed.add('multi-tab');

    for (const { codecMessageId, message } of messages) {
      if (!branchSelection(codecMessageId).hasSiblings) continue;
      if (message.role === 'assistant') completed.add('regenerate');
      if (message.role === 'user') completed.add('edit');
    }

    return scenarios.filter((s) => s.id !== undefined && !completed.has(s.id));
  }, [scenarios, messages, branchSelection, runOf, ablyMessages]);
}
