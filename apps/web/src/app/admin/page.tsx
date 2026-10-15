"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Users,
  Send,
  Activity,
  ShieldAlert,
  CheckCircle,
  Clock,
  Layers,
  Sparkles,
  AlertCircle,
  PlusCircle,
  RefreshCw,
  LogOut,
  Ban,
  Mail,
  Calendar,
} from "lucide-react";
import { createAdminCampaign } from "@/lib/api";

export default function AdminPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"overview" | "campaigns" | "compose">("overview");

  // Check authentication on mount
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        // Detailed metrics are only returned to authenticated sessions
        if (!data.subscribers) {
          router.push("/admin/login");
        }
      })
      .catch(() => {
        router.push("/admin/login");
      });
  }, [router]);

  async function handleLogout() {
    await fetch("/api/admin/auth", { method: "DELETE" });
    router.push("/admin/login");
  }

  // Campaigns list state & cancellation
  const [campaignList, setCampaignList] = useState<any[]>([]);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(false);
  const [cancellingCampaignId, setCancellingCampaignId] = useState<string | null>(null);
  const [campaignActionMsg, setCampaignActionMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadCampaigns = useCallback(async () => {
    setIsLoadingCampaigns(true);
    try {
      const res = await fetch("/api/admin/campaigns");
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      const data = await res.json();
      if (res.ok && data.campaigns) {
        setCampaignList(data.campaigns);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingCampaigns(false);
    }
  }, [router]);

  useEffect(() => {
    if (activeTab === "campaigns") {
      loadCampaigns();
    }
  }, [activeTab, loadCampaigns]);

  async function handleCancelCampaign(campaignId: string, campaignTitle: string) {
    if (
      !confirm(
        `Are you sure you want to cancel campaign: "${campaignTitle}"? This will abort pending dispatches immediately.`
      )
    ) {
      return;
    }
    setCancellingCampaignId(campaignId);
    setCampaignActionMsg(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/cancel`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setCampaignActionMsg({
          type: "error",
          text: data.error || data.message || "Failed to cancel campaign",
        });
      } else {
        setCampaignActionMsg({
          type: "success",
          text: data.message || "Campaign cancelled successfully.",
        });
        await loadCampaigns();
      }
    } catch {
      setCampaignActionMsg({
        type: "error",
        text: "Failed to reach server to cancel campaign",
      });
    } finally {
      setCancellingCampaignId(null);
    }
  }

  // Compose State
  const [title, setTitle] = useState("AI Signal #01: Frontier Reasoning & Inference Scaling");
  const [subject, setSubject] = useState("AI Signal #01: Why test-time compute is replacing parameter scaling");
  const [previewText, setPreviewText] = useState("3 critical frontier updates, 1 quiet-STaR paper breakdown, and 1 execution sandbox signal.");
  const [contentHtml, setContentHtml] = useState(`
<h2>1. Three Frontier Developments</h2>
<p><strong>A. Inference Scaling:</strong> Monte Carlo Tree Search paired with test-time verifiers is yielding faster accuracy gains than doubling pretraining parameters.</p>
<p><strong>B. Speculative Decoding:</strong> Serving runtimes report 2.4x throughput increase with draft models.</p>
<p><strong>C. Edge Tool Execution:</strong> Distilled 8B models successfully executing multi-step tool calls.</p>
<h2>2. Research Paper: Quiet-STaR</h2>
<p>Language models can learn to think quietly before every word through self-supervised objectives.</p>
<h2>3. Startup Signal</h2>
<p>The rise of deterministic execution sandboxes over static vector search.</p>
<h2>4. Actionable Takeaway</h2>
<p>Implement retry loops with compiler stderr in your coding agents before switching to larger models.</p>
  `.trim());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusType, setStatusType] = useState<"success" | "error" | "">("");

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setStatusMessage("");
    setStatusType("");

    try {
      const data = await createAdminCampaign({
        title,
        subject,
        previewText,
        contentHtml,
      });

      setStatusType("success");
      setStatusMessage(
        `Campaign created successfully! Enqueued as Job ID: ${data.jobId}. Background worker will dispatch it in batches.`
      );
    } catch (err: any) {
      if (err.status === 401) {
        router.push("/admin/login");
        return;
      }
      setStatusType("error");
      setStatusMessage(err.message || "Failed to schedule campaign.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-8 border-b border-border mb-8">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-brand uppercase tracking-wider mb-1">
            <Layers className="w-4 h-4" />
            <span>Platform Operating System</span>
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            AI Signal Console
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Subscriber management, double opt-in audit, campaign dispatch, and durable queue telemetry.
          </p>
        </div>

        {/* Tab Controls & Logout */}
        <div className="flex items-center gap-3">
          <div className="flex bg-surface-200 border border-border p-1 rounded-xl text-xs font-semibold text-slate-400">
            <button
              onClick={() => setActiveTab("overview")}
              className={`px-4 py-2 rounded-lg transition-all ${
                activeTab === "overview"
                  ? "bg-brand text-white shadow-md shadow-brand/20"
                  : "hover:text-white"
              }`}
            >
              Overview &amp; Telemetry
            </button>
            <button
              onClick={() => setActiveTab("campaigns")}
              className={`px-4 py-2 rounded-lg transition-all ${
                activeTab === "campaigns"
                  ? "bg-brand text-white shadow-md shadow-brand/20"
                  : "hover:text-white"
              }`}
            >
              Campaigns
            </button>
            <button
              onClick={() => setActiveTab("compose")}
              className={`px-4 py-2 rounded-lg transition-all ${
                activeTab === "compose"
                  ? "bg-brand text-white shadow-md shadow-brand/20"
                  : "hover:text-white"
              }`}
            >
              Compose Campaign
            </button>
          </div>

          <button
            onClick={handleLogout}
            title="Log out"
            className="p-2 rounded-xl bg-surface-200 border border-border text-slate-400 hover:text-red-400 hover:border-red-500/30 transition-all text-xs flex items-center gap-1.5"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-8">
          {/* Key Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-5 rounded-2xl">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-3">
                <span>Confirmed Active</span>
                <Users className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-3xl font-black text-white">Ready</div>
              <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> Eligible for Friday delivery
              </div>
            </div>

            <div className="glass-card p-5 rounded-2xl">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-3">
                <span>Double Opt-In</span>
                <Clock className="w-4 h-4 text-amber-400" />
              </div>
              <div className="text-3xl font-black text-white">72h Expiry</div>
              <div className="text-xs text-amber-400 mt-1">Signed HMAC protection</div>
            </div>

            <div className="glass-card p-5 rounded-2xl">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-3">
                <span>Suppression List</span>
                <ShieldAlert className="w-4 h-4 text-rose-400" />
              </div>
              <div className="text-3xl font-black text-white">Active</div>
              <div className="text-xs text-slate-400 mt-1">Auto-blocks hard bounces</div>
            </div>

            <div className="glass-card p-5 rounded-2xl">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-3">
                <span>Worker Queue</span>
                <Activity className="w-4 h-4 text-brand-accent" />
              </div>
              <div className="text-3xl font-black text-white">Durable</div>
              <div className="text-xs text-slate-400 mt-1">FOR UPDATE SKIP LOCKED</div>
            </div>
          </div>

          {/* Workflow Status Blueprint */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="glass-card p-6 rounded-2xl">
              <h3 className="font-bold text-white text-base mb-4 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-brand" />
                Active Automation Pipelines
              </h3>
              <ul className="space-y-3 text-xs text-slate-300">
                <li className="p-3 rounded-xl bg-surface-200 border border-border flex items-center justify-between">
                  <div>
                    <strong className="text-white">Workflow A: Double Opt-In Verification</strong>
                    <div className="text-slate-400">Tokens signed with HMAC-SHA256, 72h lifecycle</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                    Online
                  </span>
                </li>
                <li className="p-3 rounded-xl bg-surface-200 border border-border flex items-center justify-between">
                  <div>
                    <strong className="text-white">Workflow B: Weekly Campaign Batch Worker</strong>
                    <div className="text-slate-400">Recipient snapshot, exclusion filtering, rate throttling</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                    Online
                  </span>
                </li>
                <li className="p-3 rounded-xl bg-surface-200 border border-border flex items-center justify-between">
                  <div>
                    <strong className="text-white">Workflow C: RFC 8058 1-Click Unsubscribe</strong>
                    <div className="text-slate-400">List-Unsubscribe and List-Unsubscribe-Post headers</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                    Online
                  </span>
                </li>
                <li className="p-3 rounded-xl bg-surface-200 border border-border flex items-center justify-between">
                  <div>
                    <strong className="text-white">Workflow D: Provider Webhook Telemetry</strong>
                    <div className="text-slate-400">Automatic hard-bounce &amp; complaint suppression</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                    Online
                  </span>
                </li>
              </ul>
            </div>

            <div className="glass-card p-6 rounded-2xl flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-white text-base mb-2">
                  Ready to Dispatch Your Next Issue?
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Draft and review your 4-part issue in the composer tab. The background worker will snapshot eligible subscribers, verify suppression status, generate individual unsubscribe tokens, and deliver via your active email provider.
                </p>
                <div className="p-4 rounded-xl bg-surface-200 border border-border/80 text-xs text-slate-300 space-y-1">
                  <div className="text-white font-semibold">Active Email Provider:</div>
                  <div className="text-brand-accent font-mono">Console / Offline Mock Logger</div>
                  <div className="text-slate-500 text-[11px] pt-1">
                    Emails are rendered to terminal &amp; saved to .local_emails/ for zero-risk local inspection. Switch to Resend or SES via .env when launching public beta.
                  </div>
                </div>
              </div>

              <div className="mt-6">
                <button
                  onClick={() => setActiveTab("compose")}
                  className="w-full py-3 rounded-xl bg-brand hover:bg-brand-hover text-white text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-md shadow-brand/20"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>Draft New Issue Now</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "campaigns" && (
        <div className="glass-card p-6 sm:p-8 rounded-3xl space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border">
            <div>
              <h2 className="text-xl font-bold text-white">Dispatched &amp; Scheduled Campaigns</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Monitor delivery lifecycles, real-time dispatch progress, and execute atomic cancellations.
              </p>
            </div>
            <button
              onClick={loadCampaigns}
              disabled={isLoadingCampaigns}
              className="px-4 py-2 rounded-xl bg-surface-200 border border-border text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-2 transition-all self-start sm:self-auto disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingCampaigns ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>

          {campaignActionMsg && (
            <div
              className={`p-4 rounded-xl text-xs flex items-start gap-2.5 ${
                campaignActionMsg.type === "success"
                  ? "bg-emerald-950/40 border border-emerald-500/30 text-emerald-300"
                  : "bg-rose-950/40 border border-rose-500/30 text-rose-300"
              }`}
            >
              {campaignActionMsg.type === "success" ? (
                <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
              )}
              <span className="leading-relaxed">{campaignActionMsg.text}</span>
            </div>
          )}

          {campaignList.length === 0 && !isLoadingCampaigns ? (
            <div className="text-center py-16 px-4">
              <Mail className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <h3 className="text-base font-bold text-white">No campaigns found</h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1 mb-5">
                You haven&apos;t scheduled or sent any newsletter issues yet.
              </p>
              <button
                onClick={() => setActiveTab("compose")}
                className="px-5 py-2.5 rounded-xl bg-brand hover:bg-brand-hover text-white text-xs font-semibold inline-flex items-center gap-2 transition-all shadow-md shadow-brand/20"
              >
                <PlusCircle className="w-4 h-4" />
                <span>Create First Campaign</span>
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead>
                  <tr className="border-b border-border text-slate-400 uppercase tracking-wider text-[10px]">
                    <th className="pb-3 pr-4 font-semibold">Issue</th>
                    <th className="pb-3 px-4 font-semibold">Title &amp; Subject</th>
                    <th className="pb-3 px-4 font-semibold">Status</th>
                    <th className="pb-3 px-4 font-semibold">Recipients</th>
                    <th className="pb-3 px-4 font-semibold">Timeline</th>
                    <th className="pb-3 pl-4 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {campaignList.map((c) => {
                    const isCancellable = c.status === "scheduled" || c.status === "sending";
                    const isCancelling = cancellingCampaignId === c.id;

                    const statusBadgeColors: Record<string, string> = {
                      sent: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
                      partially_failed: "bg-amber-500/10 text-amber-400 border-amber-500/20",
                      failed: "bg-rose-500/10 text-rose-400 border-rose-500/20",
                      sending: "bg-sky-500/10 text-sky-400 border-sky-500/20",
                      scheduled: "bg-violet-500/10 text-violet-400 border-violet-500/20",
                      cancelled: "bg-slate-500/10 text-slate-400 border-slate-500/20",
                    };

                    return (
                      <tr key={c.id} className="hover:bg-surface-200/50 transition-colors">
                        <td className="py-4 pr-4 font-mono font-bold text-white">
                          #{c.issueNumber ?? "—"}
                        </td>
                        <td className="py-4 px-4 max-w-xs">
                          <div className="font-semibold text-white truncate">{c.title}</div>
                          <div className="text-[11px] text-slate-400 truncate">{c.subject}</div>
                        </td>
                        <td className="py-4 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                              statusBadgeColors[c.status] || "bg-surface-200 text-slate-300 border-border"
                            }`}
                          >
                            {c.status === "sending" && <RefreshCw className="w-3 h-3 animate-spin" />}
                            {c.status}
                          </span>
                        </td>
                        <td className="py-4 px-4">
                          <div className="font-medium text-white">
                            {c.successfulSends ?? 0} / {c.totalRecipients ?? 0} sent
                          </div>
                          {(c.failedSends ?? 0) > 0 && (
                            <div className="text-[11px] text-rose-400">
                              {c.failedSends} failed
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-4 text-[11px] text-slate-400">
                          {c.sentAt ? (
                            <div>Sent {new Date(c.sentAt).toLocaleDateString()}</div>
                          ) : c.scheduledAt ? (
                            <div>Sched {new Date(c.scheduledAt).toLocaleDateString()}</div>
                          ) : (
                            <div>Created {new Date(c.createdAt).toLocaleDateString()}</div>
                          )}
                        </td>
                        <td className="py-4 pl-4 text-right">
                          {isCancellable ? (
                            <button
                              onClick={() => handleCancelCampaign(c.id, c.title)}
                              disabled={isCancelling}
                              className="px-3 py-1.5 rounded-lg bg-rose-950/40 border border-rose-500/30 hover:bg-rose-900/50 hover:border-rose-500 text-rose-300 text-[11px] font-semibold inline-flex items-center gap-1.5 transition-all disabled:opacity-50"
                            >
                              {isCancelling ? (
                                <>
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                  <span>Cancelling...</span>
                                </>
                              ) : (
                                <>
                                  <Ban className="w-3 h-3" />
                                  <span>Cancel</span>
                                </>
                              )}
                            </button>
                          ) : (
                            <span className="text-slate-500 text-[11px]">Finalized</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "compose" && (
        <form onSubmit={handleCreateCampaign} className="glass-card p-6 sm:p-8 rounded-3xl space-y-6">
          <div className="flex items-center justify-between pb-4 border-b border-border">
            <div>
              <h2 className="text-xl font-bold text-white">Newsletter Campaign Composer</h2>
              <p className="text-xs text-slate-400">
                Craft, preview, and enqueue a weekly intelligence issue.
              </p>
            </div>
          </div>

          {statusMessage && (
            <div
              className={`p-4 rounded-xl text-xs flex items-start gap-2.5 ${
                statusType === "success"
                  ? "bg-emerald-950/40 border border-emerald-500/30 text-emerald-300"
                  : "bg-rose-950/40 border border-rose-500/30 text-rose-300"
              }`}
            >
              {statusType === "success" ? (
                <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
              )}
              <span className="leading-relaxed">{statusMessage}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Internal Campaign Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-surface-200 border border-border text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Email Subject Line
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 rounded-xl bg-surface-200 border border-border text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand font-medium"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Preheader Preview Text (Visible in email client list)
            </label>
            <input
              type="text"
              value={previewText}
              onChange={(e) => setPreviewText(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-surface-200 border border-border text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand font-medium"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Issue HTML Content
            </label>
            <textarea
              rows={12}
              value={contentHtml}
              onChange={(e) => setContentHtml(e.target.value)}
              required
              className="w-full px-3.5 py-2.5 rounded-xl bg-surface-200 border border-border text-white text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand leading-relaxed"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-3 rounded-xl bg-gradient-to-r from-brand to-brand-accent hover:from-brand-hover hover:to-brand-accent text-white font-semibold text-xs flex items-center gap-2 shadow-lg shadow-brand/20 transition-all disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Queueing Delivery...</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Enqueue Campaign Delivery</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
