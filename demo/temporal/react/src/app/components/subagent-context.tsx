'use client';

import { createContext, useContext } from 'react';
import type * as AI from 'ai';

import type { MessageInfo } from './message-list';
import type { SubagentLinkMaps } from '../hooks/use-subagent-links';

/**
 * Shared rendering state for the nested subagent display. MessageBubble
 * pulls these from context so it can render a `spawn_subagent` tool call
 * as an inline subagent block (showing the linked run's own messages),
 * without every intermediate component drilling the maps.
 */
export interface SubagentRendering {
  /** All messages in the session view, projected as UIMessages keyed by id. */
  messagesByRun: ReadonlyMap<string, readonly AI.UIMessage[]>;
  /** Per-message metadata mirroring the top-level chat — used inside the nested render. */
  info: ReadonlyMap<string, MessageInfo>;
  /** Subagent-link maps from {@link useSubagentLinks}. */
  links: SubagentLinkMaps;
  /** The id of the currently-streaming assistant message, if any. */
  streamingId: string | undefined;
}

export const SubagentRenderingContext = createContext<SubagentRendering | undefined>(undefined);

export function useSubagentRendering(): SubagentRendering | undefined {
  return useContext(SubagentRenderingContext);
}
