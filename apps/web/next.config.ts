import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/lib/csp";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@dealmind/shared"],
  eslint: { ignoreDuringBuilds: true }, // Linting runs as its own turbo task.
  // Phase 7.1: hardening headers on every response (CSP is per-request, in middleware).
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
