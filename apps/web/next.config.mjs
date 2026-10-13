/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@ai-signal/config",
    "@ai-signal/db",
    "@ai-signal/email",
    "@ai-signal/queue",
    "@ai-signal/validation",
  ],
  reactStrictMode: true,
};

export default nextConfig;
