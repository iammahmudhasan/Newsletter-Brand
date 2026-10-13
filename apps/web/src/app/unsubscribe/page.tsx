import { verifySignedToken } from "@ai-signal/config";
import { UnsubscribeClient } from "./UnsubscribeClient";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

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
            To unsubscribe, please use the direct link provided in the footer of any AI Signal newsletter email.
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

  // Strictly enforce purpose === 'unsubscribe'
  const verification = verifySignedToken(token, "unsubscribe");

  return (
    <UnsubscribeClient
      token={token}
      email={verification.payload?.email}
      initialValid={verification.valid}
      errorMessage={verification.error}
    />
  );
}
