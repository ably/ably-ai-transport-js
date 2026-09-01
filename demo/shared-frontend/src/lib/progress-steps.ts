/**
 * The scenario shapes that `useDemoProgress` tracks, `SuggestionChips` renders
 * as chips, and `IntroCard` renders as a walkthrough. These live apart from the
 * hook so a presentational component can take them as a prop type without
 * pulling in the hook's AI SDK and transport dependencies, which lets a demo on
 * a non-Vercel codec reuse those components.
 */

import type { ReactNode } from 'react';

/** A trackable scenario's stable id — maps to a built-in completion detector. */
export type DemoStepId =
  | 'server-weather'
  | 'client-weather'
  | 'approval-forecast'
  | 'retry-stock'
  | 'checklist'
  | 'multi-tab'
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
