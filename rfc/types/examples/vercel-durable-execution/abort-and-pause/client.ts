/**
 * Abort and pause — client side (durable execution).
 *
 * Same shape as the serverless variant. The client publishes the
 * abort, pause, or resume signal to the channel; the next workflow
 * hop picks it up through its AIT step. For pause, the run ends
 * `suspended` and the client POSTs the returned resume invocation to
 * wake a new workflow run.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientView } from '../../../index.js';

/**
 * View-wide stop button. Aborts every run that is currently active in
 * the view — concurrent runs (subagent fan-out, multi-panel chat) are
 * cancelled by one click. Each abort publishes its own signal and
 * returns an {@link Invocation}; the handler fires off one wake-up
 * POST per run so stalled workflows get resumed regardless of which
 * run they were processing.
 * @param view - The client view being rendered.
 * @returns Resolves once every active run has had its abort signal
 *   published and wake-up POSTs have been dispatched.
 */
export const onStopAllClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const activeRuns = view.runs.filter((r) => r.status === 'active');
  const invocations = await Promise.all(activeRuns.map(async (r) => r.abort()));
  for (const invocation of invocations) {
    void fetch('/api/workflow/start', {
      method: 'POST',
      body: JSON.stringify(invocation.toJSON()),
    });
  }
};

/**
 * Stop a specific run. Called from a run-scoped UI control.
 * @param run - The run to abort.
 * @returns Resolves once the abort signal has been published.
 */
export const onStopRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  if (run.status !== 'active') return;
  const invocation = await run.abort();
  void fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Pause a specific run. Durable signal — picked up by the next hop
 * via its AIT step whether or not a hop is currently executing.
 * @param run - The run to pause.
 * @returns Resolves once the pause signal has been published and the
 *   wake-up invocation POST has been dispatched.
 */
export const onPauseRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  if (run.status !== 'active') return;
  const invocation = await run.pause();
  void fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Resume a specific suspended run. Awaits the POST so the UI can
 * enable progress indicators only once the workflow endpoint has
 * accepted the wake-up.
 * @param run - The suspended run to resume.
 * @returns Resolves once the resume signal has been published and the
 *   workflow invocation POST has completed.
 */
export const onResumeRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  if (run.status !== 'suspended') return;
  const invocation = await run.resume();
  await fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
