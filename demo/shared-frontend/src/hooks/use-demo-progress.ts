/**
 * useDemoProgress — given a demo's scenario list, derives which scenarios are
 * still unfinished from the conversation tree, so the suggestion chips stay in
 * sync across clients via the channel-backed history.
 *
 * A `Scenario` is the single source of truth for both the intro-card walkthrough
 * and the suggestion chips: the intro renders every scenario; the chips render
 * the trackable, still-unfinished ones. Completion is detected by `id`:
 * - server-weather: a turn called getWeather without a preceding getLocation
 * - client-weather: a turn called getLocation
 * - approval-forecast: a turn produced a getWeatherForecast output (approved)
 * - retry-stock: a turn produced a getStockPrice output
 * - checklist: a turn produced an updateChecklist output (LiveObjects)
 * - multi-tab: more than one distinct Run.clientId appears across visible Runs
 * - regenerate: any assistant message belongs to a Run with siblings
 * - edit: any user message belongs to a Run with siblings
 * - cancel: an ai-cancel event appears on the channel
 *
 * A scenario with no `id` (e.g. the Observability walkthrough entry) is shown in
 * the intro but never offered as a chip and never tracked.
 */

import { useMemo, type ReactNode } from 'react';
import type * as Ably from 'ably';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { EVENT_CANCEL, type BranchHandle, type CodecMessage, type RunInfo } from '@ably/ai-transport';

/** A trackable scenario's stable id — maps to a built-in completion detector. */
export type DemoStepId =
  | 'server-weather'
  | 'client-weather'
  | 'approval-forecast'
  | 'retry-stock'
  | 'checklist'
  | 'multi-tab'
  | 'edit'
  | 'regenerate'
  | 'cancel';

/**
 * One demo scenario, feeding both the intro-card walkthrough and the suggestion
 * chips. A demo lists the scenarios its model can drive; the shared UI derives
 * the chips (trackable, unfinished) and the intro (all of them) from it.
 */
export interface Scenario {
  /**
   * Stable id → the built-in completion detector and the chip/dedup key. Omit
   * for intro-only entries (e.g. Observability) that are never tracked or
   * offered as a chip.
   */
  id?: DemoStepId;
  /** Short category tag shown on the chip and above the intro action line. */
  tag: string;
  /** Intro-card entry heading. */
  title: string;
  /** Intro-card explanation of what the scenario demonstrates. */
  blurb: string;
  /**
   * A prompt to send. When present the scenario is offered as a clickable
   * suggestion chip, and the intro line reads `Ask: "<prompt>"` unless `action`
   * overrides it.
   */
  prompt?: string;
  /**
   * A user gesture (no prompt), e.g. "open in new tab and chat from both". Shown
   * as a non-clickable chip and as the intro line body unless `action` overrides.
   */
  gesture?: string;
  /**
   * Escape hatch for a rich intro-line body — links, or a compound
   * prompt-plus-gesture ("Ask …, then click Approve"). Overrides the line
   * auto-rendered from `prompt`/`gesture`; it does not affect the chip.
   */
  action?: ReactNode;
}

/**
 * Filter a demo's scenarios down to the trackable ones still unfinished, in the
 * demo's own order. Drives the suggestion chips.
 */
export function useDemoProgress(
  scenarios: readonly Scenario[],
  messages: CodecMessage<UIMessage>[],
  branchSelection: (codecMessageId: string) => BranchHandle<UIMessage>,
  runOf: (codecMessageId: string) => RunInfo | undefined,
  ablyMessages: Ably.InboundMessage[],
): Scenario[] {
  return useMemo(() => {
    const completed = new Set<DemoStepId>();

    if (ablyMessages.some((m) => m.name === EVENT_CANCEL)) {
      completed.add('cancel');
    }

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].message.role !== 'user') continue;

      const turnTools = new Set<string>();
      const turnOutputs = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const m = messages[j].message;
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

    const runClientIds = new Set<string>();
    for (const { codecMessageId, message } of messages) {
      const run = runOf(codecMessageId);
      if (run?.clientId) runClientIds.add(run.clientId);
      if (!branchSelection(codecMessageId).hasSiblings) continue;
      if (message.role === 'assistant') completed.add('regenerate');
      if (message.role === 'user') completed.add('edit');
    }
    if (runClientIds.size > 1) completed.add('multi-tab');

    return scenarios.filter((s) => s.id !== undefined && !completed.has(s.id));
  }, [scenarios, messages, branchSelection, runOf, ablyMessages]);
}
