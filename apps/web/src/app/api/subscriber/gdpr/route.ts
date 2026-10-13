import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, consentEvents, suppressions, eq, and } from "@ai-signal/db";
import { verifySignedToken, normalizeEmail } from "@ai-signal/config";

// GDPR Data Export (Right of Access) - strictly requires 'data_export' purpose token
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token");
    if (!token) {
      return NextResponse.json({ error: "Missing authentication token" }, { status: 400 });
    }

    const verification = verifySignedToken(token, "data_export");
    if (!verification.valid || !verification.payload) {
      return NextResponse.json(
        { error: verification.error || "Invalid or expired data_export token" },
        { status: 401 }
      );
    }

    const { id: subscriberId, email: tokenEmail } = verification.payload;
    const normalizedEmail = normalizeEmail(tokenEmail);

    const [subscriber] = await db
      .select()
      .from(subscribers)
      .where(
        and(
          eq(subscribers.id, subscriberId),
          eq(subscribers.email, normalizedEmail)
        )
      );

    if (!subscriber) {
      return NextResponse.json(
        { error: "Subscriber not found or identity mismatch" },
        { status: 404 }
      );
    }

    const consents = await db
      .select()
      .from(consentEvents)
      .where(eq(consentEvents.subscriberId, subscriberId));

    return NextResponse.json({
      exportDate: new Date().toISOString(),
      subscriber: {
        id: subscriber.id,
        email: subscriber.email,
        status: subscriber.status,
        signupSource: subscriber.signupSource,
        confirmedAt: subscriber.confirmedAt,
        createdAt: subscriber.createdAt,
      },
      consentHistory: consents,
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to export data" }, { status: 500 });
  }
}

// GDPR Right to be Forgotten (Permanent Deletion) - strictly requires 'data_delete' purpose token
export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: "Missing authorization token" }, { status: 400 });
    }

    const verification = verifySignedToken(token, "data_delete");
    if (!verification.valid || !verification.payload) {
      return NextResponse.json(
        { error: verification.error || "Invalid or expired data_delete token" },
        { status: 401 }
      );
    }

    const { id: subscriberId, email: tokenEmail } = verification.payload;
    const normalizedEmail = normalizeEmail(tokenEmail);

    // Verify subscriber existence and email match before destruction
    const [subscriber] = await db
      .select()
      .from(subscribers)
      .where(
        and(
          eq(subscribers.id, subscriberId),
          eq(subscribers.email, normalizedEmail)
        )
      );

    if (!subscriber) {
      return NextResponse.json(
        { error: "Subscriber not found or identity mismatch" },
        { status: 404 }
      );
    }

    // 1. Delete subscriber record (cascades to campaign_recipients & consent_events)
    await db.delete(subscribers).where(eq(subscribers.id, subscriberId));

    // 2. Add email to suppressions to guarantee they are never contacted again
    await db
      .insert(suppressions)
      .values({
        email: normalizedEmail,
        reason: "manual_unsubscribe",
        details: "GDPR Right to Be Forgotten validated deletion request",
      })
      .onConflictDoNothing();

    return NextResponse.json({
      success: true,
      message: "Your personal data has been permanently deleted from our records.",
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to process deletion" }, { status: 500 });
  }
}
