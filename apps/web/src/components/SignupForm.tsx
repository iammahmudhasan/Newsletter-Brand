"use client";

import React, { useState } from "react";
import { CheckCircle2, ArrowRight, Loader2, AlertCircle, ShieldCheck } from "lucide-react";
import { subscribeToNewsletter } from "@/lib/api";

export function SignupForm({ source = "landing_hero" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !email.includes("@")) {
      setStatus("error");
      setMessage("Please enter a valid email address.");
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const data = await subscribeToNewsletter(email, source);
      setStatus("success");
      setMessage(
        data.message ||
          "Verification email dispatched! Please click the confirmation link in your inbox to complete activation."
      );
    } catch (err: any) {
      setStatus("error");
      setMessage(err.message || "Failed to subscribe. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="p-6 rounded-2xl bg-surface-100 border border-emerald-500/30 text-left shadow-xl shadow-emerald-500/5 animate-in fade-in zoom-in-95 duration-300">
        <div className="flex items-start gap-3.5">
          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 mt-0.5">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white mb-1">Check your inbox</h3>
            <p className="text-sm text-slate-300 leading-relaxed">{message}</p>
            <div className="mt-4 pt-3 border-t border-border/60 flex items-center gap-2 text-xs text-slate-400">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Double opt-in verification protects against spam and ensures deliverability.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      id="newsletter-signup-form"
      onSubmit={handleSubmit}
      className="w-full flex flex-col gap-3"
      noValidate
    >
      <div className="flex flex-col sm:flex-row gap-2.5">
        <div className="relative flex-1">
          <input
            id="subscriber-email-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter your work or developer email..."
            required
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck="false"
            disabled={status === "loading"}
            className="w-full px-4 py-3.5 rounded-xl bg-surface-200 border border-border text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all text-sm font-medium disabled:opacity-50"
          />
        </div>
        <button
          id="subscriber-submit-button"
          type="submit"
          disabled={status === "loading"}
          className="px-6 py-3.5 rounded-xl bg-gradient-to-r from-brand to-brand-accent hover:from-brand-hover hover:to-brand-accent text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-brand/25 hover:shadow-brand/40 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
        >
          {status === "loading" ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Joining...</span>
            </>
          ) : (
            <>
              <span>Join Free</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

      {status === "error" && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-950/40 border border-red-500/20 px-3 py-2 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-500 pt-1 px-1">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>Next issue dispatches Friday at 9:00 AM</span>
        </div>
        <span>100% Free · 1-click unsubscribe</span>
      </div>
    </form>
  );
}
