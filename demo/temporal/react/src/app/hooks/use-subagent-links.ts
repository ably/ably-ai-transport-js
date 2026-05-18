'use client';

import { useEffect, useState } from 'react';
import type * as Ably from 'ably';

import { SUBAGENT_LINK_MESSAGE_NAME, type SubagentLink } from '../../lib/subagent-link';

/**
 * Subscribe to the demo:subagent-link sidecar messages on the session
 * channel and project them into two lookup maps that the chat UI uses to
 * nest subagent runs underneath the parent's `spawn_subagent` tool call.
 *
 * Both live messages and a snapshot of the channel's history are
 * processed so late-joining (refresh, second device) clients see the
 * full parent→child tree the AIT session is already carrying. The map
 * upserts are idempotent on parentToolCallId, so any overlap between
 * history and live delivery is harmless.
 */
export interface SubagentLinkMaps {
  /** Keyed by the parent's tool-call id — used when rendering tool parts. */
  byToolCallId: ReadonlyMap<string, SubagentLink>;
  /** Keyed by the subagent's run id — used to filter subagent runs out of the top-level message list. */
  byRunId: ReadonlyMap<string, SubagentLink>;
}

const empty: SubagentLinkMaps = { byToolCallId: new Map(), byRunId: new Map() };

const isSubagentLink = (value: unknown): value is SubagentLink => {
  if (value === null || typeof value !== 'object') return false;
  // CAST: trust boundary — `value` is wire data from an Ably message,
  // narrowed to a plain object above. Reading fields off a
  // `Record<string, unknown>` lets the typed checks below act as the
  // runtime guard before the function returns `value is SubagentLink`.
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === 'string' &&
    typeof v.parentRunId === 'string' &&
    typeof v.parentToolCallId === 'string' &&
    typeof v.description === 'string'
  );
};

export function useSubagentLinks(ably: Ably.Realtime | undefined, sessionName: string): SubagentLinkMaps {
  const [maps, setMaps] = useState<SubagentLinkMaps>(empty);

  useEffect(() => {
    if (ably === undefined) return;
    const channel = ably.channels.get(sessionName);
    const byToolCallId = new Map<string, SubagentLink>();
    const byRunId = new Map<string, SubagentLink>();
    let disposed = false;

    const emit = (): void => {
      if (disposed) return;
      setMaps({ byToolCallId: new Map(byToolCallId), byRunId: new Map(byRunId) });
    };

    const upsert = (data: unknown): void => {
      if (!isSubagentLink(data)) return;
      byToolCallId.set(data.parentToolCallId, data);
      byRunId.set(data.runId, data);
    };

    const listener = (msg: Ably.InboundMessage): void => {
      upsert(msg.data);
      emit();
    };
    void channel.subscribe(SUBAGENT_LINK_MESSAGE_NAME, listener);

    // Replay any historical link messages so late-joining clients hydrate
    // the full subagent tree. Errors are non-fatal — live delivery still
    // works without history.
    void (async () => {
      try {
        const page = await channel.history({ limit: 1000 });
        for (const item of page.items) {
          if (item.name === SUBAGENT_LINK_MESSAGE_NAME) upsert(item.data);
        }
        emit();
      } catch (err) {
        console.error('failed to load subagent-link history', err);
      }
    })();

    return () => {
      disposed = true;
      channel.unsubscribe(SUBAGENT_LINK_MESSAGE_NAME, listener);
    };
  }, [ably, sessionName]);

  return maps;
}
