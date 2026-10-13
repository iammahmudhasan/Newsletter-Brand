import Link from "next/link";
import { db, subscribers, suppressions, eq } from "@ai-signal/db";
import { verifySignedToken } from "@ai-signal/config";
import { CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-border">
          <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Unsubscribe</h1>
          <p className="text-sm text-slate-400 mb-6">
            To unsubscribe, please use the direct link at the bottom of any AI Signal newsletter email.
          </p>
          <Link
            href="/"
            className="inline-flex px-5 py-2.5 rounded-xl bg-surface-200 text-white text-sm font-semibold border border-border"
          >
            Return to Homepage
          </Link>
        </div>
      </div>
    );
  }

  const verification = verifySignedToken(token);

  if (!verification.valid || !verification.payload) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-rose-500/20">
          <AlertTriangle className="w-12 h-12 text-rose-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Invalid or Expired Link</h1>
          <p className="text-sm text-slate-400 mb-6">
            The unsubscribe token provided is invalid or expired.
          </p>
          <Link
            href="/"
            className="inline-flex px-5 py-2.5 rounded-xl bg-surface-200 text-white text-sm font-semibold border border-border"
          >
            Return to Homepage
          </Link>
        </div>
      </div>
    );
  }

  const { id: subscriberId, email } = verification.payload;

  // Process unsubscribe
  try {
    // 1. Update subscriber status
    await db
      .update(subscribers)
      .set({
        status: "unsubscribed",
      })
      .where(eq(subscribers.id, subscriberId));

    // 2. Add to suppressions
    await db
      .insert(suppressions)
      .values({
        email,
        reason: "manual_unsubscribe",
        details: "User initiated 1-click unsubscribe",
      })
      .onConflictDoNothing();
  } catch (err: any) {
    console.error("[Unsubscribe Error]:", err.message);
  }

  return (
    <div className="max-w-lg mx-auto my-24 px-4 text-center">
      <div className="glass-card p-8 sm:p-10 rounded-3xl border-border shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-surface-100 text-slate-400 border border-border flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-8 h-8 text-emerald-400" />
        </div>

        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">
          You have been unsubscribed
        </h1>

        <p className="text-sm text-slate-300 leading-relaxed mb-6">
          <code className="text-slate-300 bg-surface-200 px-2 py-0.5 rounded text-xs">{email}</code> has been removed
          from all future AI Signal campaign dispatches.
        </p>

        <div className="p-4 rounded-xl bg-surface-200 border border-border/80 text-left text-xs text-slate-400 space-y-2 mb-8">
          <div className="flex items-center gap-2 text-slate-300 font-semibold">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Suppression Rules Applied</span>
          </div>
          <p>
            Your address has been placed on our suppression list. You will not receive any marketing or automated emails.
          </p>
        </div>

        <div className="flex gap-3 justify-center">
          <Link
            href="/"
            className="px-5 py-2.5 rounded-xl bg-surface-200 hover:bg-surface-100 text-slate-300 text-sm font-semibold transition-all border border-border"
          >
            Return to Homepage
          </Link>
        </div>
      </div>
    </div>
  );
}
