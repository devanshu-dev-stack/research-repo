/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are TS source; let Next transpile them.
  transpilePackages: [
    "@research-repo/core",
    "@research-repo/db",
    "@research-repo/pipeline",
  ],
  serverExternalPackages: ["@prisma/client", "bullmq", "ioredis", "tesseract.js"],
  experimental: { esmExternals: true },
};
export default nextConfig;
