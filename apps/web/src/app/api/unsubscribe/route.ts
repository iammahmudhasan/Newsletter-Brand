import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, suppressions, eq, and } from "@ai-signal/db";
import { verifySignedToken, normalizeEmail } from "@ai-signal/config";

// Reject GET requests with 405 Method Not Allowed (prevent scanners from mutating state)
export async function GET() {
  return NextResponse.json(
    { error: "Method Not Allowed. Unsubscribe actions must be submitted via POST." },
    { status: 405, headers: { Allow: "POST" } }
  );
}

// Supports RFC 8058 one-click unsubscribe POST requests & user page action
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    let token = url.searchParams.get("token");

    // Also check body if token was passed in json
    if (!token) {
      try {
        const body = await req.json();
        token = body.token;
      } catch {
        // Body wasn't JSON, ignore
      }
    }

    if (!token) {
      return NextResponse.json({ error: "Missing required unsubscribe token" }, { status: 400 });
    }

    // Strictly enforce purpose === 'unsubscribe'
    const verification = verifySignedToken(token, "unsubscribe");
    if (!verification.valid || !verification.payload) {
      return NextResponse.json(
        { error: verification.error || "Invalid or expired unsubscribe token" },
        { status: 400 }
      );
    }

    const { id: subscriberId, email: tokenEmail } = verification.payload;
    const normalizedTokenEmail = normalizeEmail(tokenEmail);

    // Verify subscriber exists in database and email matches
    const [subscriber] = await db
      .select()
      .from(subscribers)
      .where(
        and(
          eq(subscribers.id, subscriberId),
          eq(subscribers.email, normalizedTokenEmail)
        )
      );

    if (!subscriber) {
      return NextResponse.json(
        { error: "Subscriber record not found or token identity mismatch" },
        { status: 404 }
      );
    }

    // 1. Update subscriber status
    await db
      .update(subscribers)
      .set({
        status: "unsubscribed",
        updatedAt: new Date(),
      })
      .where(eq(subscribers.id, subscriberId));

    // 2. Add to suppressions
    await db
      .insert(suppressions)
      .values({
        email: normalizedTokenEmail,
        reason: "manual_unsubscribe",
        details: "Validated POST unsubscribe request (RFC 8058 or web form)",
      })
      .onConflictDoNothing();

    return NextResponse.json(
      {
        success: true,
        message: "You have been successfully unsubscribed from AI Signal.",
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[Unsubscribe API Error]:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
