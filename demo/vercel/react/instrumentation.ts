/**
 * Pre-warm the agent {@link AgentSession} for the default session at server
 * boot. Without this, the first user publish races the agent route's first
 * `connect()` and the user message lands on the channel before the agent
 * subscribes — so the agent never sees it. Pre-warming attaches the session
 * before any client is connected.
 *
 * Only runs in the Node.js runtime (skipped in the edge runtime). Loaded by
 * Next.js automatically when present at the project root.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

const resolveSessionName = (base: string, namespace: string | undefined): string =>
  namespace !== undefined && namespace.length > 0 ? `${namespace}:${base}` : base;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { getSession } = await import('./src/lib/agent-session');

  const baseName = process.env.NEXT_PUBLIC_ABLY_SESSION ?? 'demo-session';
  const namespace = process.env.NEXT_PUBLIC_ABLY_NAMESPACE;
  const sessionName = resolveSessionName(baseName, namespace);

  try {
    await getSession(sessionName);
    // eslint-disable-next-line no-console
    console.log(`[instrumentation] agent session "${sessionName}" pre-warmed`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[instrumentation] failed to pre-warm agent session "${sessionName}"`, err);
  }
}
