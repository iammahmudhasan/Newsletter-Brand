import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#08090e",
        surface: {
          50: "#171c2b",
          100: "#121624",
          200: "#0e111c",
          300: "#0a0c14",
        },
        border: "#1d2335",
        brand: {
          DEFAULT: "#6366f1",
          hover: "#4f46e5",
          accent: "#8b5cf6",
          cyan: "#06b6d4",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Roboto",
          "sans-serif",
        ],
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow": "glow 2s ease-in-out infinite alternate",
      },
      keyframes: {
        glow: {
          "0%": { boxShadow: "0 0 15px rgba(99, 102, 241, 0.3)" },
          "100%": { boxShadow: "0 0 25px rgba(139, 92, 246, 0.6)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
