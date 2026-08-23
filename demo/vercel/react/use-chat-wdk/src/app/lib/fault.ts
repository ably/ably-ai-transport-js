/**
 * Fault modes the demo can arm to exercise WDK's retry + AIT's supersede.
 *
 * Both fire on the inference activity's **first attempt only** (gated on
 * `getStepMetadata().attempt`), before the activity publishes anything, so WDK
 * re-runs the activity as a fresh process and the retry (attempt 2) succeeds —
 * it re-enters the same run under the same AIT step id, and the turn settles
 * once with no duplicate.
 *
 * The armed mode rides a one-shot cookie: the client sets it when a fault is
 * armed, the chat route reads it off the next POST, threads it into the
 * workflow input, and clears it on the response. The AIT chat transport owns
 * the POST body, so demo controls travel out-of-band.
 */
export type FaultMode =
  // Throw a WDK `RetryableError` on attempt 1 — a graceful, backed-off retry.
  | 'fail-once'
  // Throw an uncaught error on attempt 1 — the closest stand-in for a worker
  // dying mid-step; WDK redelivers and re-runs the activity.
  | 'crash';

/** The cookie the armed fault rides on (client sets, chat route consumes). */
export const FAULT_COOKIE = 'wdk-fault';

/** The `Set-Cookie` value the chat route responds with to consume the armed fault. */
export const CLEAR_FAULT_COOKIE = `${FAULT_COOKIE}=; Path=/; Max-Age=0`;

/**
 * Read the armed fault out of a request's `Cookie` header.
 * @param cookieHeader - The raw `Cookie` header, or null when absent.
 * @returns The armed fault mode, or undefined when none is armed.
 */
export function parseFaultCookie(cookieHeader: string | null): FaultMode | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === FAULT_COOKIE && (value === 'fail-once' || value === 'crash')) return value;
  }
  return undefined;
}
