/**
 * Workflow-bundler options shared by the worker entry and the workflow tests.
 *
 * This exists only because the demo consumes the SDK through a local link
 * (`link:../../..`). The SDK's workflow shim imports `@temporalio/workflow`, and
 * Node resolves that from the link's real path — the repo root — which has its
 * own copy. Webpack would then bundle TWO copies, and Temporal's runtime classes
 * use private fields, so a `CancellationScope` built by one copy cannot be read
 * by the other ("Cannot read private member #cancelRequested").
 *
 * The alias below forces every import of `@temporalio/workflow` to this app's
 * copy. A consumer installing `@ably/ai-transport` from npm never hits this: the
 * package declares `@temporalio/workflow` as a peer dependency, so there is only
 * ever one copy to resolve.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import type { WorkerOptions } from '@temporalio/worker';

const require_ = createRequire(import.meta.url);

// The package DIRECTORY, not its entry file: webpack treats an alias as a prefix,
// so aliasing to `lib/index.js` would resolve `@temporalio/workflow/lib/foo` to
// `lib/index.js/lib/foo`.
const workflowPackageDir = path.dirname(require_.resolve('@temporalio/workflow/package.json'));

/** Bundler options that dedupe `@temporalio/workflow` onto this app's copy. */
export const bundlerOptions: WorkerOptions['bundlerOptions'] = {
  webpackConfigHook: (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@temporalio/workflow': workflowPackageDir,
      },
    },
  }),
};
