import Link from "next/link";
import { db, subscribers, eq } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { verifySignedToken } from "@ai-signal/config";
import { CheckCircle2, AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-red-500/20">
          <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Missing Verification Token</h1>
          <p className="text-sm text-slate-400 mb-6">
            The confirmation link appears to be incomplete. Please check the full link in your email.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand-hover transition-colors"
          >
            Back to Home &rarr;
          </Link>
        </div>
      </div>
    );
  }

  const verification = verifySignedToken(token);

  if (!verification.valid || !verification.payload) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-red-500/30">
          <AlertTriangle className="w-12 h-12 text-rose-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Token Expired or Invalid</h1>
          <p className="text-sm text-slate-400 mb-6">
            {verification.error || "This confirmation link has expired or has already been used."}
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand-hover transition-colors"
          >
            Request New Link on Homepage
          </Link>
        </div>
      </div>
    );
  }

  const { id: subscriberId, email } = verification.payload;

  // Activate subscriber in database
  let alreadyActive = false;
  try {
    const [subscriber] = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId));

    if (subscriber) {
      if (subscriber.status === "active") {
        alreadyActive = true;
      } else {
        await db
          .update(subscribers)
          .set({
            status: "active",
            confirmedAt: new Date(),
          })
          .where(eq(subscribers.id, subscriberId));

        // Queue welcome sequence
        await enqueueJob("send_welcome", {
          subscriberId,
          email,
        });
      }
    }
  } catch (err: any) {
    console.error("[Confirm Page Error]:", err.message);
  }

  return (
    <div className="max-w-lg mx-auto my-24 px-4 text-center">
      <div className="glass-card p-8 sm:p-10 rounded-3xl border-emerald-500/30 shadow-2xl shadow-emerald-500/10">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-8 h-8" />
        </div>

        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">
          {alreadyActive ? "Already Confirmed!" : "Subscription Confirmed!"}
        </h1>

        <p className="text-sm text-slate-300 leading-relaxed mb-6">
          Welcome to <strong className="text-white">AI Signal</strong>. Your email (
          <code className="text-brand-accent bg-surface-200 px-2 py-0.5 rounded text-xs">{email}</code>) has been
          verified and added to the weekly dispatch list.
        </p>

        <div className="p-4 rounded-xl bg-surface-200 border border-border/80 text-left text-xs text-slate-400 space-y-2 mb-8">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold">
            <ShieldCheck className="w-4 h-4" />
            <span>Opt-In Consent Verified</span>
          </div>
          <p>
            Your first weekly intelligence briefing will arrive this Friday at 9:00 AM.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/archive"
            className="px-5 py-3 rounded-xl bg-brand hover:bg-brand-hover text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all shadow-md shadow-brand/20"
          >
            <span>Read Recent Issues</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/"
            className="px-5 py-3 rounded-xl bg-surface-200 hover:bg-surface-100 text-slate-300 text-sm font-semibold transition-all border border-border"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
