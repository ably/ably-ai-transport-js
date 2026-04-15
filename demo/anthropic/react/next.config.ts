import path from "path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

const nextConfig: NextConfig = {
  // Strict Mode double-mounts cause TransportProvider to close the transport on
  // the first cleanup cycle while the ref persists, leaving a closed transport on
  // remount. Disable until TransportProvider handles this correctly.
  reactStrictMode: false,
  serverExternalPackages: ["jsonwebtoken", "ably", "@anthropic-ai/claude-agent-sdk"],
  webpack: (config) => {
    // Resolve @ably/ai-transport imports to source files instead of the pre-built
    // dist/ bundles. The dist bundles contain a Rolldown CJS runtime shim that
    // calls `require("react")` (breaks in the browser) and inline `ably` imports
    // that bypass `serverExternalPackages` (breaks native ws on the server).
    // With source aliases, webpack compiles the TS directly and can properly
    // externalize `ably` on the server via `serverExternalPackages`.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@ably/ai-transport/react": path.join(repoRoot, "src/react/index.ts"),
      "@ably/ai-transport/anthropic": path.join(repoRoot, "src/anthropic/index.ts"),
      "@ably/ai-transport": path.join(repoRoot, "src/index.ts"),
    };

    // Source files use .js extensions in imports (standard TS ESM convention).
    // Webpack needs to resolve .js imports to .ts files.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
