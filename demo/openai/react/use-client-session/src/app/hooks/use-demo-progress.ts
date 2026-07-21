/**
 * useDemoProgress — derives which intro-card demo steps are still unfinished
 * from the conversation tree, so suggestion chips stay in sync across clients
 * via the channel-backed history.
 *
 * Steps detected from tree state:
 * - server-weather: a turn ran the getWeather tool (a function_call paired with
 *   a function_call_output)
 * - multi-tab: more than one distinct turn-client-id appears across turns
 * - regenerate: any assistant node has siblings (forked via Regenerate)
 * - edit: any user node has siblings (forked via Edit)
 * - cancel: a cancel signal was seen on the channel
 *
 * Client-side tools and approval-gated tools are not part of this demo yet, so
 * (unlike the Vercel demo) there are no chips for them. The "open Debug pane"
 * intro step is local UI state, so it is not tracked here either.
 */

import { useMemo } from 'react';
import type * as Ably from 'ably';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { EVENT_CANCEL } from '@ably/ai-transport';
import type { OpenAIMessage } from '@ably/ai-transport/openai';

export type DemoStepId = 'server-weather' | 'multi-tab' | 'edit' | 'regenerate' | 'cancel';

export interface PromptDemoStep {
  /** Which step this is. */
  id: DemoStepId;
  /** A prompt step: clicking the chip prefills {@link prompt}. */
  type: 'prompt';
  /** Short uppercase category shown before the label. */
  tag: string;
  /** The chip's human-readable label. */
  label: string;
  /** The prompt text the chip prefills into the input. */
  prompt: string;
}

export interface GestureDemoStep {
  /** Which step this is. */
  id: DemoStepId;
  /** A gesture step: a non-clickable hint describing a UI action. */
  type: 'gesture';
  /** Short uppercase category shown before the label. */
  tag: string;
  /** The hint's human-readable label. */
  label: string;
}

/** One demo step: either a clickable prompt chip or a gesture hint. */
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
    id: 'multi-tab',
    type: 'gesture',
    tag: 'Multi-client sync',
    label: 'open in new tab and chat from both',
  },
  {
    id: 'edit',
    type: 'gesture',
    tag: 'Branching',
    label: 'hover a user message, click edit',
  },
  {
    id: 'regenerate',
    type: 'gesture',
    tag: 'Branching',
    label: 'hover an assistant reply, click regenerate',
  },
  {
    id: 'cancel',
    type: 'gesture',
    tag: 'Cancel mid-stream',
    label: 'send a long prompt, click Stop while it streams',
  },
];

/** Whether a turn ran the getWeather tool — a function_call paired with its output. */
function ranServerWeather(turn: OpenAIMessage): boolean {
  const weatherCallIds = new Set<string>();
  const outputCallIds = new Set<string>();
  for (const item of turn.items) {
    if (item.type === 'function_call' && item.name === 'getWeather') weatherCallIds.add(item.call_id);
    else if (item.type === 'function_call_output') outputCallIds.add(item.call_id);
  }
  for (const callId of weatherCallIds) if (outputCallIds.has(callId)) return true;
  return false;
}

/**
 * Derive the still-unfinished demo steps from the conversation tree. Reruns when
 * the visible turns, branch state, run lookup, or channel messages change.
 * @param messages - The visible turns paired with their codec-message-ids.
 * @param branchSelection - Branch handle lookup, for detecting forked (edited/regenerated) nodes.
 * @param runOf - Run lookup, for the client id that owns each turn.
 * @param ablyMessages - Raw channel messages, for detecting a cancel signal.
 * @returns The steps not yet demonstrated, in canonical order.
 */
export function useDemoProgress(
  messages: CodecMessage<OpenAIMessage>[],
  branchSelection: (codecMessageId: string) => BranchHandle<OpenAIMessage>,
  runOf: (codecMessageId: string) => RunInfo | undefined,
  ablyMessages: Ably.InboundMessage[],
): DemoStep[] {
  return useMemo(() => {
    const completed = new Set<DemoStepId>();

    if (ablyMessages.some((m) => m.name === EVENT_CANCEL)) completed.add('cancel');

    for (const { message } of messages) {
      if (message.role === 'assistant' && ranServerWeather(message)) completed.add('server-weather');
    }

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

    return ALL_STEPS.filter((s) => !completed.has(s.id));
  }, [messages, branchSelection, runOf, ablyMessages]);
}
