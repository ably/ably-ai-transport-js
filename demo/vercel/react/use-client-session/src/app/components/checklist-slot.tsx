'use client';

/**
 * Wrapper that pulls the current `session` from the shared UI's hook context
 * and feeds it into {@link ChecklistWidget}. Rendered as the `extraSlot`
 * on {@link Chat} so the widget lives inside `ClientSessionProvider` and
 * can observe LiveObjects state on the session's channel.
 */

import { SessionHooks } from '@ably-ai-demos/frontend';
import { ChecklistWidget } from './checklist-widget';

export function ChecklistSlot() {
  const { session } = SessionHooks.useClientSession();
  return <ChecklistWidget session={session} />;
}
