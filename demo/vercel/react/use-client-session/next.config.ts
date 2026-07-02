import path from 'path';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

const nextConfig: NextConfig = {
  serverExternalPackages: ['jsonwebtoken', 'ably'],
  // The shared frontend package ships raw TSX; Next.js needs to transpile it.
  transpilePackages: ['@ably-ai-demos/frontend'],
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
