/**
 * Abort and pause — client side.
 *
 * Abort and pause are durable state on the session: the client publishes
 * the signal, and the agent reacts to it whether or not it was live when
 * the signal hit the channel. The surface splits into a view-wide
 * "cancel everything" handler and three run-specific handlers for stop,
 * pause, and resume.
 *
 * Per plan §5.3, control signals return an {@link Invocation} the caller
 * POSTs to the agent endpoint when no agent is currently running. The
 * caller decides fire-and-forget vs `await` based on whether they need to
 * guarantee the lifecycle state lands.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientView } from '../../../index.js';

/**
 * View-wide stop button. Aborts every run that is currently active in
 * the view — concurrent runs (subagent fan-out, multi-panel chat) are
 * cancelled by one click. Each abort publishes its own signal and
 * returns an {@link Invocation}; the handler fires off one wake-up
 * POST per run so stalled agents get woken regardless of which run
 * they were processing.
 * @param view - The client view being rendered.
 * @returns Resolves once every active run has had its abort signal
 *   published and wake-up POSTs have been dispatched.
 */
export const onStopAllClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const activeRuns = view.runs.filter((r) => r.status === 'active');
  const invocations = await Promise.all(activeRuns.map(async (r) => r.abort()));
  for (const invocation of invocations) {
    void fetch('/api/agent', {
      method: 'POST',
      body: JSON.stringify(invocation.toJSON()),
    });
  }
};

/**
 * Stop a specific run. Called from a run-scoped UI control (e.g. a
 * stop button rendered inside a specific conversation thread).
 * @param run - The run to abort.
 * @returns Resolves once the abort signal has been published.
 */
export const onStopRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  if (run.status !== 'active') return;
  const invocation = await run.abort();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Pause a specific run. Follows the same durable-signal pattern as
 * abort — the pause lands on the channel regardless of whether an
 * agent is live to observe it.
 * @param run - The run to pause.
 * @returns Resolves once the pause signal has been published and the
 *   wake-up invocation POST has been dispatched.
 */
export const onPauseRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  if (run.status !== 'active') return;
  const invocation = await run.pause();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Resume a specific suspended run. Awaits the POST so the caller
 * learns the agent endpoint accepted the wake-up — useful when the UI
 * wants to enable progress indicators only once the server has
 * accepted the resume.
 * @param run - The suspended run to resume.
 * @returns Resolves once the resume signal has been published and the
 *   wake-up POST has completed.
 */
export const onResumeRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  if (run.status !== 'suspended') return;
  const invocation = await run.resume();
  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
