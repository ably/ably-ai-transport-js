/**
 * Shared end-to-end test launcher for the demos.
 *
 * Invoked from a demo directory (its `test:e2e` script runs
 * `node ../../../e2e/run-e2e.mjs`). Provisions a throwaway Ably sandbox app over
 * the sandbox REST API (no key or secret needed; mirrors test/helper/test-setup.ts),
 * then runs that demo's Playwright suite with the deterministic mock LLM enabled.
 *
 * It resolves Playwright and the ably-common submodule relative to the invoking
 * demo (process.cwd()), so a single copy serves every demo.
 *
 * It sets, for the Playwright run and the Next.js dev server it spawns:
 *   ABLY_API_KEY              the provisioned sandbox key
 *   ABLY_ENDPOINT             nonprod:sandbox  (agent)
 *   NEXT_PUBLIC_ABLY_ENDPOINT nonprod:sandbox  (browser)
 *   MOCK_LLM                  1
 *
 * Extra arguments are forwarded to `playwright test`, e.g.
 *   pnpm run test:e2e -- --grep "fresh send"
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const SANDBOX_REST_URL = 'https://sandbox-rest.ably.io/apps';

/** Walk up from a starting directory to find the ably-common test-app setup. */
function findTestAppSetup(startDir) {
  const rel = join('ably-common', 'test-resources', 'test-app-setup.json');
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`unable to locate ${rel} above ${startDir}; is the ably-common submodule checked out?`);
}

/** Provision a sandbox app and return a key with full channel permissions. */
async function provisionSandboxKey() {
  const setupPath = findTestAppSetup(process.cwd());
  const setup = JSON.parse(readFileSync(setupPath, 'utf8'));

  // AIT streams by appending/updating Ably messages, which the channel
  // namespace must permit (mutableMessages). The demos publish under the `ai:`
  // namespace, so the sandbox app needs an `ai` namespace with that feature,
  // plus persistence so refresh/history-reconstruction tests can replay it. The
  // shared test-app-setup.json only ships a `mutable` namespace (used by the
  // SDK's own integration tests), so we add `ai` here rather than editing it.
  const body = setup.post_apps;
  const namespaces = Array.isArray(body.namespaces) ? body.namespaces : [];
  if (!namespaces.some((ns) => ns.id === 'ai')) {
    namespaces.push({ id: 'ai', mutableMessages: true, persisted: true });
  }
  body.namespaces = namespaces;

  const response = await fetch(SANDBOX_REST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`sandbox app provisioning failed (HTTP ${response.status})`);
  }
  const app = await response.json();
  // Index 5 is the key with permissions across all channel qualifiers and
  // namespaces (matches the SDK integration-test setup).
  const key = app?.keys?.[5]?.keyStr;
  if (!key) {
    throw new Error('sandbox app provisioned but no key found at index 5');
  }
  return key;
}

/**
 * Locate the @playwright/test CLI entry (cli.js at the package root), resolved
 * from the invoking demo so we use the demo's own Playwright install.
 */
function playwrightCli() {
  const require = createRequire(join(process.cwd(), 'package.json'));
  let dir = dirname(require.resolve('@playwright/test'));
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return join(dir, 'cli.js');
}

async function main() {
  const key = await provisionSandboxKey();
  console.log('[e2e] provisioned Ably sandbox app; running Playwright with mock LLM');

  const env = {
    ...process.env,
    ABLY_API_KEY: key,
    ABLY_ENDPOINT: 'nonprod:sandbox',
    NEXT_PUBLIC_ABLY_ENDPOINT: 'nonprod:sandbox',
    MOCK_LLM: '1',
  };

  // Run the Playwright CLI directly with `node` (rather than the `playwright`
  // bin) so spawning works identically on Windows and POSIX without a shell.
  const child = spawn(process.execPath, [playwrightCli(), 'test', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error('[e2e] setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
