/**
 * Best-effort session teardown helpers for a Temporal activity's catch
 * block. The activity constructs its own `AgentSession` inside `try`; if
 * the throw happens before construction, `session` is still undefined and
 * these are a no-op. If the underlying call itself throws (channel already
 * gone, etc.), swallow — the outer throw carries the real failure. Never
 * throws.
 *
 * Two shapes:
 *
 * - `safeSessionDetach` — close the channel subscription without publishing
 *   anything. Any open run/step on the wire stays open. Use in the catch
 *   of a **retryable** activity path: on rethrow, Temporal will retry the
 *   activity, and the retry needs the run to still be `active` so it can
 *   `run.load()` and publish a superseding step attempt under the same
 *   `stepId`.
 *
 * - `safeSessionEnd` — gracefully close the session, which cascades to
 *   end any open runs (published as `ai-run-end`). Use ONLY in the
 *   workflow-level failure path (`cleanupRun`), where retries are already
 *   exhausted and we deliberately want the run marked terminal.
 *
 * Structural upper bounds so these don't force the caller's codec generics
 * through the type — both `AgentSession` and `ClientSession` satisfy them.
 */

interface EndableSession {
  /** Gracefully close the session (idempotent per the session's own contract). */
  end(): Promise<void>;
}

interface DetachableSession {
  /** Detach the session's channel subscription without publishing lifecycle events. */
  detach(): Promise<void>;
}

export const safeSessionEnd = async (session: EndableSession | undefined): Promise<void> => {
  if (!session) return;
  try {
    await session.end();
  } catch {
    /* best-effort — the channel may already be gone */
  }
};

export const safeSessionDetach = async (session: DetachableSession | undefined): Promise<void> => {
  if (!session) return;
  try {
    await session.detach();
  } catch {
    /* best-effort — the channel may already be gone */
  }
};
