import path from 'path';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

const nextConfig: NextConfig = {
  serverExternalPackages: ['jsonwebtoken', 'ably'],
  transpilePackages: ['@ably-ai-demos/frontend'],
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
