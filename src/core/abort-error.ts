/**
 * Detect a web-standard signal-driven abort error. `AbortSignal`-driven
 * paths (fetch, the Vercel AI SDK, most model SDK clients) throw a
 * `DOMException` whose `name` is `'AbortError'` when their bound signal
 * fires. Some SDKs wrap the abort in their own error class (e.g. the
 * OpenAI SDK's `APIUserAbortError` carries the original `AbortError` on
 * `cause`), so the check walks the cause chain.
 *
 * Used by the run-end and step-end classifiers to distinguish
 * signal-driven errors (`'aborted'`) from genuine errors coincident
 * with an abort observation (`'failed'`).
 * @param error The caught error to classify.
 * @returns True when the error appears to be signal-driven.
 */
export const isAbortSignalError = (error: unknown): boolean => {
  // Bound the cause chain walk to defend against pathological self-references.
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    if (typeof current !== 'object') {
      return false;
    }
    // CAST: errors are unstructured at the catch boundary. Read `name` and
    // `cause` defensively without committing to an `Error` shape so wrapper
    // classes from third-party SDKs are still inspected.
    const candidate = current as { name?: unknown; cause?: unknown };
    if (candidate.name === 'AbortError') {
      return true;
    }
    current = candidate.cause;
  }
  return false;
};
