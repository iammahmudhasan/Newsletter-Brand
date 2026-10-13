import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, eq, and } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { verifySignedToken, normalizeEmail } from "@ai-signal/config";

export async function GET() {
  return NextResponse.json(
    { error: "Method Not Allowed. Email confirmation must be submitted via POST." },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export async function POST(req: NextRequest) {
  try {
    let token: string | null = null;
    try {
      const body = await req.json();
      token = body.token;
    } catch {
      // not JSON
    }

    if (!token) {
      const url = new URL(req.url);
      token = url.searchParams.get("token");
    }

    if (!token) {
      return NextResponse.json({ error: "Confirmation token is required" }, { status: 400 });
    }

    // Strictly enforce purpose === 'confirm'
    const verification = verifySignedToken(token, "confirm");
    if (!verification.valid || !verification.payload) {
      return NextResponse.json(
        { error: verification.error || "Confirmation token is invalid or expired" },
        { status: 400 }
      );
    }

    const { id: subscriberId, email: tokenEmail } = verification.payload;
    const normalizedEmail = normalizeEmail(tokenEmail);

    // Verify subscriber identity in database
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
        { error: "Subscriber not found or token record mismatch" },
        { status: 404 }
      );
    }

    if (subscriber.status === "active") {
      return NextResponse.json({
        success: true,
        alreadyActive: true,
        message: "Your subscription has already been confirmed! You are all set.",
      });
    }

    if (subscriber.status !== "pending_confirmation") {
      return NextResponse.json(
        {
          error: `Cannot activate subscriber with current status: '${subscriber.status}'`,
        },
        { status: 400 }
      );
    }

    // Atomic update to prevent race conditions
    const updated = await db
      .update(subscribers)
      .set({
        status: "active",
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscribers.id, subscriberId),
          eq(subscribers.status, "pending_confirmation")
        )
      )
      .returning({ id: subscribers.id });

    if (updated.length > 0) {
      // Queue welcome email sequence
      try {
        await enqueueJob("send_welcome", {
          subscriberId,
          email: normalizedEmail,
        });
      } catch (queueErr: any) {
        console.warn("[Confirm API] Warning: welcome job enqueue failed:", queueErr.message);
      }
    }

    return NextResponse.json({
      success: true,
      message: "Subscription confirmed successfully! Welcome to AI Signal.",
    });
  } catch (err: any) {
    console.error("[Confirm API Error]:", err.message);
    return NextResponse.json({ error: "Internal confirmation error" }, { status: 500 });
  }
}
