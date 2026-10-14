import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { GdprForm } from "./GdprForm";

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 text-slate-300 leading-relaxed text-sm">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors mb-8"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Home</span>
      </Link>

      <div className="flex items-center gap-2 text-brand-accent text-xs font-bold uppercase tracking-wider mb-2">
        <ShieldCheck className="w-4 h-4" />
        <span>Legal &amp; Compliance</span>
      </div>

      <h1 className="text-3xl font-extrabold text-white tracking-tight mb-6">
        Privacy Policy
      </h1>

      <div className="space-y-6">
        <section>
          <h2 className="text-lg font-bold text-white mb-2">1. Overview</h2>
          <p>
            AI Signal (&ldquo;we&rdquo;, &ldquo;our&rdquo;) is dedicated to protecting the privacy of our subscribers. We operate an
            editorial newsletter platform focusing on artificial intelligence developments. We collect the
            minimum personal information required to deliver our publications.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">2. Information We Collect</h2>
          <ul className="list-disc pl-5 space-y-1 text-slate-400">
            <li><strong>Email Address:</strong> Used exclusively to deliver the weekly AI Signal newsletter and transactional confirmation notices.</li>
            <li><strong>Consent Metadata:</strong> Timestamp, opt-in source form, anonymized IP hash, and User-Agent string to satisfy legal consent audit requirements.</li>
            <li><strong>Engagement Telemetry:</strong> Aggregated open, click, bounce, and complaint events provided by our email infrastructure to maintain high deliverability standards.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">3. Zero Third-Party Data Sharing</h2>
          <p>
            We strictly never sell, rent, monetize, or barter your email address or personal data with any third party, advertiser, or data broker.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">4. Double Opt-In &amp; Unsubscribe Rights</h2>
          <p>
            Every subscription requires cryptographic confirmation via email (Double Opt-In). Every single newsletter email contains a visible 1-click unsubscribe link and RFC 8058 compliant headers. Unsubscribing immediately halts all marketing communications and places your email in our suppression table.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">5. Data Deletion &amp; Export (GDPR Rights)</h2>
          <p>
            You have the right to request a full copy of your data or permanently delete all your records from our systems at any time. You can contact us at{" "}
            <a href="mailto:privacy@aisignal.dev" className="text-brand-accent underline">
              privacy@aisignal.dev
            </a>{" "}
            or use our automated self-service data management tool below:
          </p>
          <Suspense fallback={<div className="p-6 text-slate-500 text-xs">Loading portal...</div>}>
            <GdprForm />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
