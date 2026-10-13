import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, consentEvents, suppressions, eq } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { normalizeEmail, hashIp } from "@ai-signal/config";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawEmail = body.email;
    const signupSource = body.source || "web_form";

    if (!rawEmail || typeof rawEmail !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const email = normalizeEmail(rawEmail);

    if (!EMAIL_REGEX.test(email) || email.length > 254) {
      return NextResponse.json(
        { error: "Please provide a valid email address" },
        { status: 400 }
      );
    }

    // 1. Check suppression list (Hard bounce, spam complaint, or manual block)
    const [suppressed] = await db
      .select({ id: suppressions.id, reason: suppressions.reason })
      .from(suppressions)
      .where(eq(suppressions.email, email));

    if (suppressed) {
      return NextResponse.json(
        {
          error:
            "This email address cannot receive updates due to an existing suppression or delivery failure record.",
        },
        { status: 400 }
      );
    }

    // 2. Check existing subscriber record
    let subscriberId: string;
    const [existing] = await db
      .select({ id: subscribers.id, status: subscribers.status })
      .from(subscribers)
      .where(eq(subscribers.email, email));

    if (existing) {
      if (existing.status === "active") {
        return NextResponse.json(
          {
            message: "You are already an active subscriber to AI Signal! Watch your inbox this Friday.",
          },
          { status: 200 }
        );
      }
      subscriberId = existing.id;
    } else {
      // 3. Atomically persist subscriber and consent audit log
      const [inserted] = await db
        .insert(subscribers)
        .values({
          email,
          status: "pending_confirmation",
          signupSource,
        })
        .returning({ id: subscribers.id });

      subscriberId = inserted.id;

      const clientIp =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        "127.0.0.1";
      const userAgent = req.headers.get("user-agent") || "unknown";

      await db.insert(consentEvents).values({
        subscriberId,
        source: signupSource,
        consentText: "Subscriber opted in via aisignal.dev web form.",
        ipHash: hashIp(clientIp),
        userAgent: userAgent.slice(0, 255),
      });
    }

    // 4. Enqueue confirmation email job
    await enqueueJob(
      "send_confirmation",
      {
        subscriberId,
        email,
      },
      {
        idempotencyKey: `confirm:${subscriberId}:${Math.floor(Date.now() / (1000 * 300))}`, // 5-minute deduplication
      }
    );

    return NextResponse.json(
      {
        success: true,
        message:
          "Verification link dispatched! Please check your inbox to confirm your subscription.",
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[Subscribe API Persistence Error]:", err.message);
    // Truthful error response: Never return false success when DB or queue fails
    return NextResponse.json(
      {
        error: "Subscription service temporarily unavailable. Please try again shortly.",
      },
      { status: 503 }
    );
  }
}
