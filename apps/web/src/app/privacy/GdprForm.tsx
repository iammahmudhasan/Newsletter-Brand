"use client";

import React, { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Trash2, CheckCircle, AlertCircle, Loader2, ShieldCheck } from "lucide-react";

export function GdprForm() {
  const searchParams = useSearchParams();
  const tokenFromUrl = searchParams.get("token");
  const actionFromUrl = searchParams.get("action");

  const [email, setEmail] = useState("");
  const [purpose, setPurpose] = useState<"data_export" | "data_delete">("data_export");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // If user arrives via confirmed email deletion link
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteCompleted, setDeleteCompleted] = useState(false);

  useEffect(() => {
    if (actionFromUrl === "delete" && tokenFromUrl) {
      setIsConfirmingDelete(true);
    }
  }, [actionFromUrl, tokenFromUrl]);

  async function handleRequestToken(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    setIsSubmitting(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/subscriber/gdpr/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, purpose }),
      });

      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: "error", text: data.error || "Failed to process request." });
      } else {
        setFeedback({
          type: "success",
          text: data.message || "A secure verification link has been dispatched to your email address.",
        });
        setEmail("");
      }
    } catch {
      setFeedback({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function executeDeletion() {
    if (!tokenFromUrl) return;

    setIsSubmitting(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/subscriber/gdpr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenFromUrl }),
      });

      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: "error", text: data.error || "Deletion failed. Token may be expired." });
      } else {
        setDeleteCompleted(true);
        setFeedback({
          type: "success",
          text: "Your subscriber records and consent history have been permanently deleted.",
        });
      }
    } catch {
      setFeedback({ type: "error", text: "Failed to connect to server." });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isConfirmingDelete) {
    return (
      <div className="glass-card p-6 rounded-2xl border border-red-500/20 bg-red-950/10 mt-6">
        <div className="flex items-center gap-2 text-red-400 font-bold text-sm mb-2">
          <Trash2 className="w-5 h-5" />
          <span>Confirm Permanent Record Deletion</span>
        </div>
        <p className="text-xs text-slate-300 mb-4">
          You are confirming the permanent removal of your email, double opt-in verification history, and activity logs. Your email will be added to the suppression list to ensure no future automated dispatches occur.
        </p>

        {feedback && (
          <div
            className={`p-3 rounded-xl text-xs mb-4 flex items-center gap-2 ${
              feedback.type === "success"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "bg-red-500/10 text-red-400 border border-red-500/20"
            }`}
          >
            {feedback.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span>{feedback.text}</span>
          </div>
        )}

        {!deleteCompleted && (
          <button
            onClick={executeDeletion}
            disabled={isSubmitting}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-600/25 transition-all disabled:opacity-50"
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            <span>Permanently Delete My Records</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="glass-card p-6 rounded-2xl border border-border bg-surface-100/60 mt-6">
      <div className="flex items-center gap-2 text-white font-bold text-sm mb-2">
        <ShieldCheck className="w-4 h-4 text-brand" />
        <span>Automated Data Management Portal</span>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Enter your email to receive a verified, cryptographically signed link to export or permanently erase your subscriber data.
      </p>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs mb-4 flex items-center gap-2 ${
            feedback.type === "success"
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : "bg-red-500/10 text-red-400 border border-red-500/20"
          }`}
        >
          {feedback.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span>{feedback.text}</span>
        </div>
      )}

      <form onSubmit={handleRequestToken} className="space-y-4">
        <div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="reader@example.com"
            required
            className="w-full px-4 py-2.5 bg-surface-200 border border-border rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label
            className={`p-3 rounded-xl border flex items-center gap-2.5 cursor-pointer transition-all ${
              purpose === "data_export"
                ? "bg-brand/10 border-brand text-white"
                : "bg-surface-200 border-border text-slate-400 hover:text-white"
            }`}
          >
            <input
              type="radio"
              name="gdpr_purpose"
              value="data_export"
              checked={purpose === "data_export"}
              onChange={() => setPurpose("data_export")}
              className="hidden"
            />
            <Download className="w-4 h-4 text-brand" />
            <span>Export Data Archive</span>
          </label>

          <label
            className={`p-3 rounded-xl border flex items-center gap-2.5 cursor-pointer transition-all ${
              purpose === "data_delete"
                ? "bg-red-500/10 border-red-500 text-white"
                : "bg-surface-200 border-border text-slate-400 hover:text-white"
            }`}
          >
            <input
              type="radio"
              name="gdpr_purpose"
              value="data_delete"
              checked={purpose === "data_delete"}
              onChange={() => setPurpose("data_delete")}
              className="hidden"
            />
            <Trash2 className="w-4 h-4 text-red-400" />
            <span>Delete All Records</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !email}
          className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-brand hover:bg-brand-hover text-white text-xs font-semibold shadow-md shadow-brand/20 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Sending Request...</span>
            </>
          ) : (
            <span>Send Secure Verification Email</span>
          )}
        </button>
      </form>
    </div>
  );
}
