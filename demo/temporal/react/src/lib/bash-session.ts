/**
 * Module-scope cache of {@link BashToolkit}s, keyed by run id.
 *
 * Each toolkit wraps a `just-bash` instance whose filesystem mounts a
 * `ReadWriteFs` at `/workspace` over a real directory on disk, so any
 * files the agent edits persist and show up in the editor. Other paths
 * the shell touches (e.g. `/tmp`) fall through to `MountableFs`'s default
 * in-memory base and never escape onto the host.
 *
 * The cache is keyed by run so each run gets its own shell (its own cwd,
 * its own in-flight command state, its own ephemeral fs branches). This
 * matters when a parent agent spawns parallel subagents — sharing one
 * `Bash` would serialise their concurrent `exec` calls and conflate
 * their cwd state. They all still share the on-disk WORKSPACE_ROOT, so
 * file contents are visible across agents.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { Bash, MountableFs, ReadWriteFs } from 'just-bash';
import type { BashToolkit } from 'bash-tool';

// `bash-tool` ships ESM-only (its package.json exports field exposes only an
// `import` condition). The Temporal worker runs via ts-node with
// `module: commonjs`, where a static import — or `await import(...)`, which TS
// downlevels to `require()` — fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Wrapping
// the dynamic import in `new Function` hides it from the TS transform so the
// runtime executes a real ESM `import()`.
const importBashTool = new Function('return import("bash-tool")') as () => Promise<typeof import('bash-tool')>;

const MOUNT_POINT = '/workspace';

/**
 * On-disk root that backs the agent's `/workspace`. Lives at
 * `<demo>/workspace` (gitignored) so the agent's edits show up in the
 * editor while leaving the repo clean.
 */
const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');

const toolkits = new Map<string, Promise<BashToolkit>>();

const createToolkit = async (): Promise<BashToolkit> => {
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  const fs = new MountableFs();
  fs.mount(MOUNT_POINT, new ReadWriteFs({ root: WORKSPACE_ROOT }));
  const bash = new Bash({ fs, cwd: MOUNT_POINT });
  const { createBashTool } = await importBashTool();
  return createBashTool({
    sandbox: bash,
    destination: MOUNT_POINT,
    extraInstructions: `You have a bash shell with read/write access to a workspace mounted at ${MOUNT_POINT}.
Use it to explore and edit files: ls, cat, grep, find, head, tail, wc, sed, awk, echo > file, etc.
Stay inside ${MOUNT_POINT}; nothing useful lives outside of it.`,
  });
};

/**
 * Resolve the cached {@link BashToolkit} for `runId`, building it on
 * first call. Subsequent calls within the same run (across steps and
 * retries) return the same toolkit so the shell's cwd / env / fs state
 * survives between iterations.
 */
export const getBashToolkit = (runId: string): Promise<BashToolkit> => {
  let toolkit = toolkits.get(runId);
  if (toolkit) return toolkit;
  toolkit = createToolkit();
  toolkits.set(runId, toolkit);
  return toolkit;
};

/**
 * Drop the cached {@link BashToolkit} for `runId`. Called when a run
 * ends so the toolkit (and its in-process state) is released — bounded
 * memory across long-lived workers.
 */
export const dropBashToolkit = (runId: string): void => {
  toolkits.delete(runId);
};
