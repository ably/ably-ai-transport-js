import path from 'path';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'jsonwebtoken',
    'ably',
    // @temporalio/client wraps @grpc/grpc-js, which relies on node's native
    // http2 module. Next's server bundler must not transform it.
    '@temporalio/client',
    '@grpc/grpc-js',
  ],
  // The shared frontend package ships raw TSX; Next.js needs to transpile it.
  transpilePackages: ['@ably-ai-demos/frontend'],
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
