import Link from "next/link";
import { db, subscribers, eq } from "@ai-signal/db";
import { verifySignedToken } from "@ai-signal/config";
import { ConfirmClient } from "./ConfirmClient";
import { AlertTriangle } from "lucide-react";

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="max-w-lg mx-auto my-24 px-4 text-center">
        <div className="glass-card p-8 rounded-3xl border-red-500/20">
          <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Missing Verification Token</h1>
          <p className="text-sm text-slate-400 mb-6">
            The confirmation link appears to be incomplete. Please check the full link in your email.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand-hover transition-colors"
          >
            Back to Home &rarr;
          </Link>
        </div>
      </div>
    );
  }

  // Strictly enforce purpose === 'confirm'
  const verification = verifySignedToken(token, "confirm");

  if (!verification.valid || !verification.payload) {
    return (
      <ConfirmClient
        token={token}
        initialValid={false}
        errorMessage={verification.error || "Token has expired or is invalid."}
      />
    );
  }

  const { id: subscriberId, email } = verification.payload;
  let alreadyActive = false;

  try {
    const [subscriber] = await db
      .select({ status: subscribers.status })
      .from(subscribers)
      .where(eq(subscribers.id, subscriberId));

    if (subscriber && subscriber.status === "active") {
      alreadyActive = true;
    }
  } catch (err: any) {
    console.warn("[Confirm Page DB check]:", err.message);
  }

  return (
    <ConfirmClient
      token={token}
      email={email}
      initialValid={true}
      alreadyActive={alreadyActive}
    />
  );
}
