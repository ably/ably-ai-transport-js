import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['jsonwebtoken', 'ably'],
};

export default nextConfig;
