import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

/** @type {import('next').NextConfig} */
const nextConfig = (phase) => {
  const isBuild = phase === PHASE_PRODUCTION_BUILD;
  if (isBuild) {
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.SKIP_ENV_VALIDATION = "true";
  }

  return {
    env: {
      NEXT_PHASE: isBuild ? "phase-production-build" : "",
    },
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
