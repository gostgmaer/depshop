import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@dealmind/shared"],
  eslint: { ignoreDuringBuilds: true }, // Linting runs as its own turbo task.
};

export default nextConfig;
