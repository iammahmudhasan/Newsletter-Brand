import { SignupForm } from "@/components/SignupForm";
import Link from "next/link";
import {
  Sparkles,
  BookOpen,
  TrendingUp,
  Cpu,
  Layers,
  ArrowUpRight,
  Shield,
  Zap,
  CheckCircle,
} from "lucide-react";

export default function HomePage() {
  return (
    <div className="relative overflow-hidden">
      {/* Background Ambient Glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] radial-glow pointer-events-none -z-10" />

      {/* Hero Section */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-20 pb-16 text-center">
        {/* Pill Badge */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-surface-100 border border-border/80 text-xs font-semibold text-brand-accent mb-8 shadow-sm">
          <Sparkles className="w-3.5 h-3.5 text-brand" />
          <span>Friday Morning Intelligence · 5-Minute Read</span>
        </div>

        {/* Hero Title */}
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-[1.15] mb-6">
          Frontier AI Research &amp; <br />
          <span className="bg-gradient-to-r from-brand via-brand-accent to-cyan-400 bg-clip-text text-transparent">
            Startup Intelligence
          </span>
        </h1>

        {/* Subtitle */}
        <p className="max-w-2xl mx-auto text-lg text-slate-300 leading-relaxed mb-10">
          Cut through marketing noise. Every Friday, receive 3 verified developments, 1 research paper
          explained, 1 startup signal, and 1 actionable technical takeaway. Written for AI engineers,
          researchers, and founders.
        </p>

        {/* Form Container */}
        <div id="subscribe-section" className="max-w-xl mx-auto mb-14">
          <div className="p-2 sm:p-3 rounded-2xl glass-panel shadow-2xl shadow-brand/10">
            <SignupForm source="hero_main" />
          </div>
        </div>

        {/* Metrics Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto pt-6 border-t border-border/50 text-left">
          <div className="p-3">
            <div className="text-2xl font-black text-white">5 Mins</div>
            <div className="text-xs text-slate-400 mt-0.5">Reading time per week</div>
          </div>
          <div className="p-3">
            <div className="text-2xl font-black text-white">100% Free</div>
            <div className="text-xs text-slate-400 mt-0.5">Audience-first access</div>
          </div>
          <div className="p-3">
            <div className="text-2xl font-black text-white">Verified</div>
            <div className="text-xs text-slate-400 mt-0.5">Original citations &amp; analysis</div>
          </div>
          <div className="p-3">
            <div className="text-2xl font-black text-white">Zero Noise</div>
            <div className="text-xs text-slate-400 mt-0.5">Strict double opt-in</div>
          </div>
        </div>
      </section>

      {/* The 4-Part Structure */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-3">
            The 4-Part Friday Briefing
          </h2>
          <p className="text-slate-400 text-sm max-w-xl mx-auto">
            Engineered to save you 10+ hours of scanning arXiv, GitHub, and tech feeds every week.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Section 1 */}
          <div className="glass-card p-6 rounded-2xl relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand/20 flex items-center justify-center text-brand mb-4">
              <Zap className="w-5 h-5" />
            </div>
            <div className="text-xs font-bold uppercase tracking-wider text-brand-accent mb-1">
              Part 01
            </div>
            <h3 className="text-xl font-bold text-white mb-2">3 Critical Developments</h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              Curated frontier models, architecture releases, and compute infrastructure news. Includes
              original commentary on why each update shifts the industry landscape.
            </p>
          </div>

          {/* Section 2 */}
          <div className="glass-card p-6 rounded-2xl relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-4">
              <BookOpen className="w-5 h-5" />
            </div>
            <div className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">
              Part 02
            </div>
            <h3 className="text-xl font-bold text-white mb-2">1 Research Paper Explained</h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              A deep, accessible breakdown of an impactful ML paper: the core hypothesis, training
              methodology, empirical results, and practical engineering limitations.
            </p>
          </div>

          {/* Section 3 */}
          <div className="glass-card p-6 rounded-2xl relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div className="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-1">
              Part 03
            </div>
            <h3 className="text-xl font-bold text-white mb-2">1 Startup &amp; Product Signal</h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              Real commercial applications, dev tools gaining adoption, or infrastructure gaps creating
              new venture and product opportunities.
            </p>
          </div>

          {/* Section 4 */}
          <div className="glass-card p-6 rounded-2xl relative overflow-hidden group">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-4">
              <Cpu className="w-5 h-5" />
            </div>
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-1">
              Part 04
            </div>
            <h3 className="text-xl font-bold text-white mb-2">1 Actionable Takeaway</h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              A concrete pattern you can test, an evaluation methodology to adapt, or a strategic decision
              framework to apply in your own codebase this week.
            </p>
          </div>
        </div>
      </section>

      {/* Sample Issue Preview Box */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <div className="rounded-3xl bg-surface-100 border border-border p-6 sm:p-10 relative overflow-hidden">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-border/80">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-brand px-2.5 py-1 rounded bg-brand/10 border border-brand/20">
                Sample Issue Preview
              </span>
              <h3 className="text-xl sm:text-2xl font-bold text-white mt-2">
                Issue #01: Frontier Reasoning &amp; Test-Time Compute
              </h3>
            </div>
            <Link
              href="/archive"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-accent hover:text-white transition-colors"
            >
              <span>Explore Archive</span>
              <ArrowUpRight className="w-4 h-4" />
            </Link>
          </div>

          <div className="mt-6 space-y-4 text-sm text-slate-300">
            <div className="p-4 rounded-xl bg-surface-200 border border-border/60">
              <div className="font-bold text-white text-base mb-1">
                🔍 Research Spotlight: &ldquo;Scaling Inference-Time Compute vs Pretraining&rdquo;
              </div>
              <p className="text-slate-400 text-xs leading-relaxed">
                Why adaptive search trajectories outperform 10x larger base models on code and mathematical reasoning, and how to replicate budget-aware sampling in production agents.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-surface-200 border border-border/60">
              <div className="font-bold text-white text-base mb-1">
                🚀 Startup Signal: Self-Correction Runtime Frameworks
              </div>
              <p className="text-slate-400 text-xs leading-relaxed">
                Early-stage teams are transitioning from static RAG pipelines to autonomous execution loops with verifiable test runners.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Editorial Standards Manifesto */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-16 text-center">
        <div className="max-w-2xl mx-auto">
          <Shield className="w-10 h-10 text-brand-accent mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-4">Our Editorial Standard</h2>
          <p className="text-sm text-slate-300 leading-relaxed mb-6">
            We believe that summarizing press releases with an LLM adds zero value. AI Signal is authored
            with deep technical synthesis, verified math, and first-principles interpretation. If a paper has
            fatal benchmark leakage, we say it.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-emerald-400" /> Human Editorial Verification
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-emerald-400" /> Direct Source Links &amp; Code
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-emerald-400" /> Uncompromised Technical Depth
            </span>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="max-w-3xl mx-auto px-4 sm:px-6 py-16 text-center">
        <div className="glass-card p-8 sm:p-12 rounded-3xl relative">
          <h2 className="text-3xl font-extrabold text-white mb-3">
            Stay Ahead of the AI Curve
          </h2>
          <p className="text-sm text-slate-400 mb-8 max-w-md mx-auto">
            Join founders, researchers, and engineers who read AI Signal every Friday.
          </p>
          <div className="max-w-md mx-auto">
            <SignupForm source="bottom_cta" />
          </div>
        </div>
      </section>
    </div>
  );
}
