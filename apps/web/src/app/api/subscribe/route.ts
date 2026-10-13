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

    const clientIp =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "127.0.0.1";
    const userAgent = req.headers.get("user-agent") || "unknown";

    // 2. ATOMIC TRANSACTION: Persist subscriber, consent audit log, and confirmation outbox job together
    const txResult = await db.transaction(async (tx) => {
      // Check existing subscriber record
      const [existing] = await tx
        .select({ id: subscribers.id, status: subscribers.status })
        .from(subscribers)
        .where(eq(subscribers.email, email));

      if (existing) {
        if (existing.status === "active") {
          return { alreadyActive: true };
        }

        const subscriberId = existing.id;

        // Ensure consent event exists (healing missing consent records on signup retries)
        const [existingConsent] = await tx
          .select({ id: consentEvents.id })
          .from(consentEvents)
          .where(eq(consentEvents.subscriberId, subscriberId))
          .limit(1);

        if (!existingConsent) {
          await tx.insert(consentEvents).values({
            subscriberId,
            source: signupSource,
            consentText: "Subscriber opted in via aisignal.dev web form.",
            ipHash: hashIp(clientIp),
            userAgent: userAgent.slice(0, 255),
          });
        }

        // Atomically enqueue confirmation email job in outbox
        await enqueueJob(
          "send_confirmation",
          {
            subscriberId,
            email,
          },
          {
            idempotencyKey: `confirm:${subscriberId}:${Math.floor(Date.now() / (1000 * 300))}`, // 5-minute deduplication
          },
          tx
        );

        return { alreadyActive: false, subscriberId };
      }

      // New subscriber path: atomically create subscriber, consent event, and confirmation job
      const [inserted] = await tx
        .insert(subscribers)
        .values({
          email,
          status: "pending_confirmation",
          signupSource,
        })
        .returning({ id: subscribers.id });

      const subscriberId = inserted.id;

      await tx.insert(consentEvents).values({
        subscriberId,
        source: signupSource,
        consentText: "Subscriber opted in via aisignal.dev web form.",
        ipHash: hashIp(clientIp),
        userAgent: userAgent.slice(0, 255),
      });

      await enqueueJob(
        "send_confirmation",
        {
          subscriberId,
          email,
        },
        {
          idempotencyKey: `confirm:${subscriberId}:${Math.floor(Date.now() / (1000 * 300))}`,
        },
        tx
      );

      return { alreadyActive: false, subscriberId };
    });

    if (txResult.alreadyActive) {
      return NextResponse.json(
        {
          message: "You are already an active subscriber to AI Signal! Watch your inbox this Friday.",
        },
        { status: 200 }
      );
    }

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
