import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, suppressions, eq } from "@ai-signal/db";
import { verifySignedToken } from "@ai-signal/config";

// Supports RFC 8058 one-click unsubscribe POST requests
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const verification = verifySignedToken(token);
    if (!verification.valid || !verification.payload) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    const { id: subscriberId, email } = verification.payload;

    // Update status & suppressions
    await db
      .update(subscribers)
      .set({ status: "unsubscribed" })
      .where(eq(subscribers.id, subscriberId));

    await db
      .insert(suppressions)
      .values({
        email,
        reason: "manual_unsubscribe",
        details: "RFC 8058 List-Unsubscribe-Post header automated trigger",
      })
      .onConflictDoNothing();

    return NextResponse.json({ success: true, message: "Unsubscribed" }, { status: 200 });
  } catch (err: any) {
    console.error("[Unsubscribe API Error]:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
