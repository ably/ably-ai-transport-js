import path from 'path';
import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

const nextConfig: NextConfig = {
  serverExternalPackages: ['jsonwebtoken', 'ably'],
  transpilePackages: ['@ably-ai-demos/frontend'],
  // Next allows one dev server per dist dir. The e2e suite points this at its
  // own directory (see playwright.config.ts) so its server can run alongside a
  // developer's `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  turbopack: {
    // The SDK is linked (`link:../../../..`) from the repo root; point Turbopack
    // at that root so the symlinked package resolves.
    root: repoRoot,
  },
};

// `withWorkflow` installs the Turbopack/webpack loaders that transform the
// `"use workflow"` / `"use step"` directives and serve the workflow handler
// endpoints under `/.well-known/workflow/v1/*`.
export default withWorkflow(nextConfig);
