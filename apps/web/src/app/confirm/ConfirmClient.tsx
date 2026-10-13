"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertTriangle, ArrowRight, ShieldCheck, Loader2, Sparkles } from "lucide-react";

export function ConfirmClient({
  token,
  email,
  initialValid,
  alreadyActive,
  errorMessage,
}: {
  token: string;
  email?: string;
  initialValid: boolean;
  alreadyActive?: boolean;
  errorMessage?: string;
}) {
  const [status, setStatus] = useState<"idle" | "submitting" | "confirmed" | "error">(
    alreadyActive ? "confirmed" : "idle"
  );
  const [errorText, setErrorText] = useState(errorMessage || "");

  if (!initialValid) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-red-500/30">
          <AlertTriangle className="w-12 h-12 text-rose-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Token Expired or Invalid</h1>
          <p className="text-sm text-slate-400 mb-6">
            {errorText || "This confirmation link is invalid or has expired."}
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

  const handleConfirm = async () => {
    setStatus("submitting");
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorText(data.error || "Confirmation failed. Please try again.");
      } else {
        setStatus("confirmed");
      }
    } catch {
      setStatus("error");
      setErrorText("A network connection error occurred. Please try again.");
    }
  };

  if (status === "confirmed") {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 sm:p-10 rounded-3xl border-emerald-500/30 shadow-2xl shadow-emerald-500/10">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-8 h-8" />
          </div>

          <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">
            Subscription Confirmed!
          </h1>

          <p className="text-sm text-slate-300 leading-relaxed mb-6">
            Welcome to <strong className="text-white">AI Signal</strong>. Your email (
            <code className="text-brand-accent bg-surface-200 px-2 py-0.5 rounded text-xs">{email}</code>) has been
            verified and added to the weekly frontier briefing dispatch list.
          </p>

          <div className="p-4 rounded-xl bg-surface-200 border border-border/80 text-left text-xs text-slate-400 space-y-2 mb-8">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold">
              <ShieldCheck className="w-4 h-4" />
              <span>Double Opt-In Consent Verified</span>
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

  return (
    <div className="max-w-lg mx-auto my-24 px-4 text-center">
      <div className="glass-card p-8 sm:p-10 rounded-3xl border-border shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-surface-100 text-brand border border-border flex items-center justify-center mx-auto mb-6">
          <Sparkles className="w-8 h-8 text-brand" />
        </div>

        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">
          Verify Your Subscription
        </h1>

        <p className="text-sm text-slate-300 leading-relaxed mb-6">
          Click below to confirm that you want to receive weekly frontier AI briefings at{" "}
          <code className="text-brand-accent bg-surface-200 px-2 py-0.5 rounded text-xs">{email}</code>.
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
            className="px-6 py-3 rounded-xl bg-brand hover:bg-brand-hover disabled:opacity-50 text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-lg shadow-brand/20"
          >
            {status === "submitting" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Confirming...</span>
              </>
            ) : (
              <span>Confirm My Subscription</span>
            )}
          </button>
          <Link
            href="/"
            className="px-5 py-3 rounded-xl bg-surface-200 hover:bg-surface-100 text-slate-300 text-sm font-semibold transition-all border border-border text-center"
          >
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
