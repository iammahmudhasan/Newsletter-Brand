import Link from "next/link";
import { notFound } from "next/navigation";
import { db, campaigns, eq } from "@ai-signal/db";
import { SignupForm } from "@/components/SignupForm";
import { ArrowLeft, Calendar, Clock, Share2, Tag } from "lucide-react";

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let issueTitle = "Frontier Reasoning, Test-Time Compute & Synthetic Data Loops";
  let issueDate = "October 10, 2026";
  let issueNumber = 1;
  let htmlContent = "";

  try {
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id));

    if (campaign) {
      issueTitle = campaign.title;
      issueDate = campaign.sentAt ? new Date(campaign.sentAt).toLocaleDateString() : "Recent";
      htmlContent = campaign.contentHtml;
    }
  } catch {
    // Dev fallback
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-14">
      {/* Back button */}
      <Link
        href="/archive"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors mb-8"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Archive</span>
      </Link>

      {/* Header */}
      <header className="pb-8 border-b border-border/80 mb-10">
        <div className="flex items-center gap-3 mb-3">
          <span className="font-mono text-xs font-bold text-brand bg-brand/10 border border-brand/20 px-2.5 py-0.5 rounded">
            Issue #{issueNumber}
          </span>
          <span className="text-xs text-slate-400 flex items-center gap-1">
            <Calendar className="w-3.5 h-3.5" />
            {issueDate}
          </span>
          <span className="text-xs text-slate-400 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            5 min read
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight mb-4">
          {issueTitle}
        </h1>

        <p className="text-sm text-slate-400 leading-relaxed">
          The weekly actionable intelligence digest on frontier foundation models, ML research breakthroughs, and startup opportunities.
        </p>
      </header>

      {/* Content */}
      {htmlContent ? (
        <article
          className="prose prose-invert max-w-none text-slate-200 leading-relaxed space-y-6"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      ) : (
        <article className="space-y-12 text-slate-200 leading-relaxed">
          {/* Section 1 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded bg-brand/10 text-brand text-xs font-bold uppercase tracking-wider border border-brand/20">
                1. Three Important Developments
              </span>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-surface-100 border border-border">
                <h3 className="font-bold text-white text-base mb-1">
                  A. Reinforcement Learning at Inference Time Moves to Enterprise SDKs
                </h3>
                <p className="text-sm text-slate-300">
                  Multiple frontier labs have documented that dynamic search strategies (Monte Carlo Tree Search + test-time verifiers) scale accuracy exponentially faster on deterministic coding challenges than doubling parameters.
                </p>
                <div className="mt-2 text-xs text-brand font-medium">
                  Source: DeepMind Research / arXiv:2408.03314
                </div>
              </div>

              <div className="p-4 rounded-xl bg-surface-100 border border-border">
                <h3 className="font-bold text-white text-base mb-1">
                  B. Speculative Decoding Latency Reductions in Open Serving Runtimes
                </h3>
                <p className="text-sm text-slate-300">
                  New draft-model pipelines in vLLM and TensorRT-LLM have lowered P99 latency by 2.4x without precision loss. For high-throughput apps, this halves cloud GPU expenditure.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-surface-100 border border-border">
                <h3 className="font-bold text-white text-base mb-1">
                  C. Synthesized Tool Execution Traces for Small Models
                </h3>
                <p className="text-sm text-slate-300">
                  Distillation of multi-step tool call traces into 8B-parameter models allows edge and on-premise execution of workflows previously requiring 70B+ parameter models.
                </p>
              </div>
            </div>
          </section>

          {/* Section 2 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded bg-purple-500/10 text-purple-400 text-xs font-bold uppercase tracking-wider border border-purple-500/20">
                2. Research Paper Explained
              </span>
            </div>

            <div className="p-6 rounded-2xl bg-surface-100 border border-purple-500/20 space-y-3">
              <h3 className="text-lg font-bold text-white">
                "Quiet-STaR: Language Models Can Teach Themselves to Think Before Speaking"
              </h3>
              <p className="text-sm text-slate-300 leading-relaxed">
                <strong>Core Hypothesis:</strong> Human thought happens quietly before every sentence. Can an LLM generate internal tokens to predict the future flow of dialogue without explicit human rationale annotations?
              </p>
              <div className="text-sm text-slate-300 space-y-2 pt-2 border-t border-border/80">
                <div><strong>Methodology:</strong> The model inserts variable-length rationales at every token position, calculates parallel cross-entropy loss, and applies REINFORCE with a learned baseline.</div>
                <div><strong>Caveats &amp; Limitations:</strong> Inference compute overhead increases by ~35% unless parallel attention heads are masked properly.</div>
                <div><strong>Why It Matters:</strong> It shows that internal reasoning tokens can emerge purely from self-supervised objectives, without costly human preference labeling.</div>
              </div>
            </div>
          </section>

          {/* Section 3 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded bg-cyan-500/10 text-cyan-400 text-xs font-bold uppercase tracking-wider border border-cyan-500/20">
                3. Startup &amp; Product Signal
              </span>
            </div>

            <div className="p-5 rounded-xl bg-surface-100 border border-cyan-500/20">
              <h3 className="text-base font-bold text-white mb-2">
                The Shift from "Retrieval-Augmented Generation" to "Deterministic Execution Sandboxes"
              </h3>
              <p className="text-sm text-slate-300 leading-relaxed">
                Startups that simply wrapped Pinecone or LangChain are facing brutal churn. The fastest growing developer infrastructure startups in Q3 2026 are lightweight, sub-50ms execution sandbox providers (MicroVMs) that allow LLMs to run code, verify tests, and self-correct before presenting answers to users.
              </p>
            </div>
          </section>

          {/* Section 4 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-400 text-xs font-bold uppercase tracking-wider border border-emerald-500/20">
                4. Actionable Takeaway
              </span>
            </div>

            <div className="p-5 rounded-xl bg-surface-100 border border-emerald-500/20 text-sm text-slate-300 leading-relaxed">
              <strong>Your weekend experiment:</strong> Before increasing your LLM prompt context to 128k tokens, measure your output accuracy with <em>test-time verification</em>. In code generation, feeding compiler stderr back to the model for 2 retry cycles yields higher benchmark gains than switching to a model 4x more expensive.
            </div>
          </section>
        </article>
      )}

      {/* Subscription callout inside article */}
      <div className="mt-16 pt-10 border-t border-border/80">
        <div className="glass-card p-8 rounded-3xl text-center">
          <h3 className="text-xl font-bold text-white mb-2">
            Enjoyed this issue?
          </h3>
          <p className="text-sm text-slate-400 max-w-md mx-auto mb-6">
            Get the next briefing delivered directly to your inbox every Friday morning at 9:00 AM.
          </p>
          <div className="max-w-md mx-auto">
            <SignupForm source="archive_post_bottom" />
          </div>
        </div>
      </div>
    </div>
  );
}
