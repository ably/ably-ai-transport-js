import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["jsonwebtoken", "ably"],
  webpack: (config) => {
    // @ably/ably-ai-transport-js source uses .js extensions in imports (standard TS ESM convention).
    // When the library is linked as source (file:../../), webpack needs to resolve
    // .js imports to .ts files.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
