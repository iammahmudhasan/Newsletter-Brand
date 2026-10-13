import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

/** @type {import('next').NextConfig} */
const nextConfig = (phase) => {
  if (phase === PHASE_PRODUCTION_BUILD) {
    process.env.NEXT_PHASE = "phase-production-build";
  }

  return {
    transpilePackages: [
      "@ai-signal/config",
      "@ai-signal/db",
      "@ai-signal/email",
      "@ai-signal/queue",
      "@ai-signal/validation",
    ],
    reactStrictMode: true,
  };
};

export default nextConfig;
