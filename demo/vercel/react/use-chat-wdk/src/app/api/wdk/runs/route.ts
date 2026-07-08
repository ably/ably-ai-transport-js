import { getRun } from 'workflow/api';

/**
 * Real per-run WDK status, for the WDK processes panel.
 *
 * Given `?ids=<workflowRunId,...>`, returns each run's authoritative status
 * (`getRun(id).status`) — the real WDK-side view that the panel overlays on the
 * live sidecar activity feed. Scoped per known run id on purpose: the global
 * `world.runs.list()` is acknowledged-unreliable on the Vercel backend, so the
 * client discovers which runs exist from the sidecar feed and asks here only to
 * confirm their status. Best-effort — a run the world can't resolve is skipped
 * rather than failing the whole response.
 */

interface WdkRunInfo {
  workflowRunId: string;
  status: string;
}

export async function GET(req: Request): Promise<Response> {
  const idsParam = new URL(req.url).searchParams.get('ids');
  const ids = idsParam ? idsParam.split(',').filter(Boolean) : [];

  const runs: WdkRunInfo[] = [];
  for (const id of ids) {
    try {
      const status = await getRun(id).status;
      runs.push({ workflowRunId: id, status });
    } catch {
      // Best-effort: skip a run the world can't resolve (e.g. not yet visible).
    }
  }

  return Response.json({ runs });
}
