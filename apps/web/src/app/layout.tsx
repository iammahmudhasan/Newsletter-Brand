import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Signal | Frontier AI Research & Startup Intelligence",
  description:
    "A weekly 5-minute actionable briefing on frontier foundation models, machine learning breakthroughs, and AI startup signals. For engineers and technical founders.",
  keywords: ["AI newsletter", "frontier models", "machine learning research", "AI startups", "LLM architecture"],
  openGraph: {
    title: "AI Signal — Frontier AI Intelligence",
    description: "Weekly 5-minute signal on frontier AI research & startup signals.",
    url: "https://aisignal.dev",
    siteName: "AI Signal",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen flex flex-col bg-background text-slate-200 antialiased selection:bg-brand selection:text-white">
        {/* Navigation Bar */}
        <header className="sticky top-0 z-50 glass-panel border-b border-border/60">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-brand to-brand-accent flex items-center justify-center shadow-lg shadow-brand/20 group-hover:scale-105 transition-transform">
                <span className="font-mono font-black text-white text-base">∑</span>
              </div>
              <div className="flex flex-col">
                <span className="font-bold tracking-tight text-white text-lg group-hover:text-brand-accent transition-colors">
                  AI SIGNAL
                </span>
              </div>
            </Link>

            <nav className="flex items-center gap-6 text-sm font-medium">
              <Link
                href="/archive"
                className="text-slate-400 hover:text-white transition-colors"
              >
                Archive
              </Link>
              <Link
                href="/admin"
                className="text-slate-400 hover:text-white transition-colors"
              >
                Dashboard
              </Link>
              <a
                href="#subscribe-section"
                className="hidden sm:inline-flex px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-semibold transition-all shadow-md shadow-brand/20 hover:shadow-brand/40"
              >
                Subscribe Free
              </a>
            </nav>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1">{children}</main>

        {/* Footer */}
        <footer className="border-t border-border/80 bg-surface-300 py-12 text-sm text-slate-500">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex flex-col gap-1 text-center md:text-left">
              <div className="font-bold text-slate-300 tracking-wider text-xs uppercase">
                AI Signal Media
              </div>
              <div>
                Weekly actionable intelligence for AI engineers, researchers, and technical founders.
              </div>
            </div>

            <div className="flex items-center gap-6 text-xs text-slate-400">
              <Link href="/archive" className="hover:text-white transition-colors">
                Past Issues
              </Link>
              <a
                href="https://github.com"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white transition-colors"
              >
                Open Architecture
              </a>
              <Link href="/admin" className="hover:text-white transition-colors">
                Admin Console
              </Link>
            </div>
          </div>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 mt-8 pt-6 border-t border-border/40 text-center text-xs text-slate-600">
            © {new Date().getFullYear()} AI Signal. Built with strict double opt-in consent and provider-independent delivery.
          </div>
        </footer>
      </body>
    </html>
  );
}
