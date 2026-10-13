import { SignupForm } from "@/components/SignupForm";
import Link from "next/link";
import { Sparkles, CheckCircle2, ShieldCheck, ArrowLeft } from "lucide-react";

export default function SubscribePage() {
  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-20 text-center">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors mb-8"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Home</span>
      </Link>

      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-100 border border-border text-xs font-semibold text-brand-accent mb-6">
        <Sparkles className="w-3.5 h-3.5 text-brand" />
        <span>Weekly Friday Briefing</span>
      </div>

      <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4">
        Subscribe to AI Signal
      </h1>

      <p className="text-sm text-slate-300 leading-relaxed mb-8 max-w-md mx-auto">
        Join AI engineers, researchers, and technical founders getting 5 minutes of high-signal
        intelligence every Friday morning.
      </p>

      <div className="glass-card p-6 sm:p-8 rounded-3xl border-border text-left shadow-2xl mb-8">
        <SignupForm source="dedicated_subscribe_page" />
      </div>

      <div className="text-left p-5 rounded-2xl bg-surface-100 border border-border/80 text-xs text-slate-400 space-y-2.5">
        <div className="font-semibold text-slate-200">What happens after you sign up?</div>
        <div className="flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>You will receive an instant verification link in your inbox (Double Opt-In).</span>
        </div>
        <div className="flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>Once confirmed, your first briefing arrives Friday at 9:00 AM.</span>
        </div>
        <div className="flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-brand-accent shrink-0 mt-0.5" />
          <span>Zero third-party sharing. Easy 1-click unsubscribe included in every email.</span>
        </div>
      </div>
    </div>
  );
}
