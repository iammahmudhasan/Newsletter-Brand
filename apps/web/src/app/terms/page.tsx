import Link from "next/link";
import { ArrowLeft, BookOpen } from "lucide-react";

export default function TermsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 text-slate-300 leading-relaxed text-sm">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors mb-8"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Home</span>
      </Link>

      <div className="flex items-center gap-2 text-brand-accent text-xs font-bold uppercase tracking-wider mb-2">
        <BookOpen className="w-4 h-4" />
        <span>Terms of Service</span>
      </div>

      <h1 className="text-3xl font-extrabold text-white tracking-tight mb-6">
        Terms of Service
      </h1>

      <div className="space-y-6">
        <section>
          <h2 className="text-lg font-bold text-white mb-2">1. Acceptance of Terms</h2>
          <p>
            By accessing AI Signal (aisignal.dev) or subscribing to our email publication, you agree to these
            Terms of Service. If you do not agree, please do not use our site or service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">2. Editorial &amp; Educational Purpose</h2>
          <p>
            All content published by AI Signal is for technical, educational, and informational purposes
            only. While we strive for extreme rigor, research interpretations, benchmarks, and model comparisons
            do not constitute formal investment or legal advice.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">3. Intellectual Property</h2>
          <p>
            The original editorial content, analyses, and brand design of AI Signal are protected by copyright.
            You are welcome to quote excerpts or share takeaways with attribution to AI Signal.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">4. Termination</h2>
          <p>
            You may terminate your subscription at any moment by clicking the unsubscribe link present in every
            email dispatch.
          </p>
        </section>
      </div>
    </div>
  );
}
