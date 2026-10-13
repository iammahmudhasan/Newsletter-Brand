/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@ai-signal/config",
    "@ai-signal/db",
    "@ai-signal/email",
    "@ai-signal/queue",
  ],
  reactStrictMode: true,
};

export default nextConfig;
