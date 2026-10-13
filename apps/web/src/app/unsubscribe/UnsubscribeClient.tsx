"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";

export function UnsubscribeClient({
  token,
  email,
  initialValid,
  errorMessage,
}: {
  token: string;
  email?: string;
  initialValid: boolean;
  errorMessage?: string;
}) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorText, setErrorText] = useState(errorMessage || "");

  if (!initialValid) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-rose-500/20">
          <AlertTriangle className="w-12 h-12 text-rose-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Invalid or Expired Link</h1>
          <p className="text-sm text-slate-400 mb-6">
            {errorText || "The unsubscribe link provided is invalid, expired, or has a mismatched token purpose."}
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

  const handleConfirm = async () => {
    setStatus("submitting");
    try {
      const res = await fetch(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorText(data.error || "Failed to process unsubscribe request.");
      } else {
        setStatus("success");
      }
    } catch {
      setStatus("error");
      setErrorText("A network error occurred. Please try again.");
    }
  };

  if (status === "success") {
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

  return (
    <div className="max-w-lg mx-auto my-24 px-4 text-center">
      <div className="glass-card p-8 sm:p-10 rounded-3xl border-border shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-surface-100 text-amber-400 border border-border flex items-center justify-center mx-auto mb-6">
          <AlertTriangle className="w-8 h-8" />
        </div>

        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">
          Confirm Unsubscribe
        </h1>

        <p className="text-sm text-slate-300 leading-relaxed mb-6">
          Are you sure you want to unsubscribe{" "}
          <code className="text-slate-200 bg-surface-200 px-2 py-0.5 rounded text-xs">{email}</code> from the AI Signal
          weekly intelligence briefing?
        </p>

        {status === "error" && (
          <div className="p-3 mb-6 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
            {errorText}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={handleConfirm}
            disabled={status === "submitting"}
            className="px-5 py-2.5 rounded-xl bg-rose-500 hover:bg-rose-600 disabled:opacity-50 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2"
          >
            {status === "submitting" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Processing...</span>
              </>
            ) : (
              <span>Confirm Unsubscribe</span>
            )}
          </button>
          <Link
            href="/"
            className="px-5 py-2.5 rounded-xl bg-surface-200 hover:bg-surface-100 text-slate-300 text-sm font-semibold transition-all border border-border text-center"
          >
            Keep My Subscription
          </Link>
        </div>
      </div>
    </div>
  );
}
