/**
 * useDemoProgress - derives which intro-card demo steps are still unfinished
 * from the linear conversation, so suggestion chips stay in sync across clients
 * via the channel-backed history.
 *
 * Steps detected from the messages:
 * - server-weather: a turn called getWeather without preceding getLocation
 * - client-weather: a turn called getLocation
 * - approval-forecast: a turn produced a getWeatherForecast output (approved)
 * - cancel: a cancel event appears in the raw Ably messages
 *
 * This demo renders a linear `useChat` message list (no branch navigation), so
 * there is no per-message Run/branch metadata; the multi-tab, edit, and
 * regenerate steps the branching `use-chat` demo tracks do not apply here.
 * Steps from the intro card that are NOT tracked here: open Debug pane (local UI
 * state only).
 */

import { useMemo } from 'react';
import type * as Ably from 'ably';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import { EVENT_CANCEL } from '@ably/ai-transport';

export type DemoStepId = 'server-weather' | 'client-weather' | 'approval-forecast' | 'cancel';

export interface PromptDemoStep {
  id: DemoStepId;
  type: 'prompt';
  tag: string;
  label: string;
  prompt: string;
}

export interface GestureDemoStep {
  id: DemoStepId;
  type: 'gesture';
  tag: string;
  label: string;
}

export type DemoStep = PromptDemoStep | GestureDemoStep;

const ALL_STEPS: DemoStep[] = [
  {
    id: 'server-weather',
    type: 'prompt',
    tag: 'Server tool',
    label: `"what's the weather in Tokyo?"`,
    prompt: `what's the weather in Tokyo?`,
  },
  {
    id: 'client-weather',
    type: 'prompt',
    tag: 'Client tool',
    label: `"what's the weather like?"`,
    prompt: `what's the weather like?`,
  },
  {
    id: 'approval-forecast',
    type: 'prompt',
    tag: 'Approval-gated tool',
    label: `"what's the weather forecast for London?"`,
    prompt: `what's the weather forecast for London?`,
  },
  {
    id: 'cancel',
    type: 'gesture',
    tag: 'Cancel mid-stream',
    label: 'send a long prompt, click Stop while it streams',
  },
];

export function useDemoProgress(messages: UIMessage[], ablyMessages: Ably.InboundMessage[]): DemoStep[] {
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
          if (part.type !== 'dynamic-tool') continue;
          const toolPart = part as DynamicToolUIPart;
          turnTools.add(toolPart.toolName);
          if (toolPart.state === 'output-available') {
            turnOutputs.add(toolPart.toolName);
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

    return ALL_STEPS.filter((s) => !completed.has(s.id));
  }, [messages, ablyMessages]);
}
