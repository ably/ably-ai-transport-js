import path from 'path';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'jsonwebtoken',
    'ably',
    '@temporalio/client',
    '@temporalio/common',
    '@temporalio/core-bridge',
  ],
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
