/**
 * Module-scope cache of {@link BashToolkit}s, keyed by session name.
 *
 * Each toolkit wraps a `just-bash` instance whose filesystem mounts a
 * `ReadWriteFs` at `/workspace` over a real directory on disk, so any
 * files the agent edits persist and show up in the editor. Other paths
 * the shell touches (e.g. `/tmp`) fall through to `MountableFs`'s default
 * in-memory base and never escape onto the host.
 *
 * The cache is keyed by session so different sessions can in principle
 * be backed by different workspaces — for now they all share the same
 * on-disk root.
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
 * Resolve the cached {@link BashToolkit} for `sessionName`, building it
 * on first call.
 */
export const getBashToolkit = (sessionName: string): Promise<BashToolkit> => {
  let toolkit = toolkits.get(sessionName);
  if (toolkit) return toolkit;
  toolkit = createToolkit();
  toolkits.set(sessionName, toolkit);
  return toolkit;
};
