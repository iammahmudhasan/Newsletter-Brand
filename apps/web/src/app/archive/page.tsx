import Link from "next/link";
import { db, campaigns, desc, sql } from "@ai-signal/db";
import { ArrowRight, Calendar, Clock, BookOpen } from "lucide-react";

// Fallback sample issues for the archive if no DB issues have been created yet
const SAMPLE_ISSUES = [
  {
    id: "sample-01",
    issueNumber: 1,
    title: "Frontier Reasoning, Test-Time Compute & Synthetic Data Loops",
    date: "October 10, 2026",
    readingTime: "5 min read",
    previewText:
      "Deep dive into why adaptive search trajectories outperform 10x larger base models on code benchmarks, plus 1 startup signal on self-correcting agent runtimes.",
    tag: "Frontier Models",
  },
  {
    id: "sample-02",
    issueNumber: 2,
    title: "Autonomous Agents in Production: Beyond Simple Vector RAG",
    date: "October 03, 2026",
    readingTime: "6 min read",
    previewText:
      "Breaking down memory graphs, speculative tool execution, and the latency trade-offs between dense vs sparse embedding pipelines.",
    tag: "Agentic Systems",
  },
  {
    id: "sample-03",
    issueNumber: 3,
    title: "Open Weights vs Proprietary APIs: The True Cost-Per-Token Calculus",
    date: "September 26, 2026",
    readingTime: "5 min read",
    previewText:
      "A complete empirical breakdown of self-hosted vLLM clusters vs serverless tokens at 50M requests/month.",
    tag: "Infra & Economics",
  },
];

export default async function ArchivePage() {
  let dbCampaigns: any[] = [];
  try {
    dbCampaigns = await db
      .select()
      .from(campaigns)
      .where(sql`${campaigns.status} IN ('sent', 'partially_failed')`)
      .orderBy(desc(campaigns.sentAt));
  } catch (err: any) {
    // If DB is offline in dev mode, fallback to sample issues
  }

  const hasIssues = dbCampaigns.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-12">
        <div className="inline-flex items-center gap-2 text-xs font-bold text-brand-accent uppercase tracking-wider mb-2">
          <BookOpen className="w-4 h-4" />
          <span>Curated Archive</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-3">
          Past Intelligence Issues
        </h1>
        <p className="text-slate-400 text-sm max-w-xl">
          Browse previous issues of AI Signal. Every issue contains 3 verified updates, 1 research paper breakdown, 1 startup signal, and 1 actionable takeaway.
        </p>
      </div>

      <div className="space-y-4">
        {hasIssues
          ? dbCampaigns.map((c, idx) => (
              <Link
                key={c.id}
                href={`/archive/${c.id}`}
                className="block glass-card p-6 rounded-2xl hover:border-brand/40 transition-all group"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-bold text-brand bg-brand/10 border border-brand/20 px-2.5 py-0.5 rounded">
                      Issue #{c.issueNumber ?? (dbCampaigns.length - idx)}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Calendar className="w-3.5 h-3.5" />
                      {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : "Recent"}
                    </span>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <Clock className="w-3.5 h-3.5" />
                    5 min read
                  </span>
                </div>
                <h2 className="text-xl font-bold text-white group-hover:text-brand-accent transition-colors mb-2">
                  {c.title}
                </h2>
                <p className="text-sm text-slate-400 line-clamp-2 mb-4">
                  {c.previewText || "Read the complete issue breakdown."}
                </p>
                <div className="flex items-center gap-1 text-xs font-semibold text-brand">
                  <span>Read Full Issue</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                </div>
              </Link>
            ))
          : SAMPLE_ISSUES.map((issue) => (
              <Link
                key={issue.id}
                href={`/archive/${issue.id}`}
                className="block glass-card p-6 rounded-2xl hover:border-brand/40 transition-all group"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-bold text-brand bg-brand/10 border border-brand/20 px-2.5 py-0.5 rounded">
                      Issue #{issue.issueNumber}
                    </span>
                    <span className="text-xs text-slate-500 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      {issue.date}
                    </span>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <Clock className="w-3.5 h-3.5" />
                    {issue.readingTime}
                  </span>
                </div>
                <h2 className="text-xl font-bold text-white group-hover:text-brand-accent transition-colors mb-2">
                  {issue.title}
                </h2>
                <p className="text-sm text-slate-400 line-clamp-2 mb-4">
                  {issue.previewText}
                </p>
                <div className="flex items-center gap-1 text-xs font-semibold text-brand">
                  <span>Read Full Issue</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                </div>
              </Link>
            ))}
      </div>
    </div>
  );
}
