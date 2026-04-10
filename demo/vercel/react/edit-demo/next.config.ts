import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["jsonwebtoken", "ably"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
