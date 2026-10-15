import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, consentEvents, suppressions, eq } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { normalizeEmail, hashIp } from "@ai-signal/config";
import { checkRateLimit, checkEmailCooldown, getClientIp, pseudonymizeRateLimitKey } from "@/lib/rateLimit";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 16384; // 16KB max payload

export async function POST(req: NextRequest) {
  try {
    // 1. Guard against oversized payloads
    let body: any;
    if (typeof req.text === "function") {
      const rawBody = await req.text();
      if (rawBody.length > MAX_BODY_BYTES) {
        return NextResponse.json(
          { error: "Payload too large. Maximum size is 16KB." },
          { status: 413 }
        );
      }
      try {
        body = JSON.parse(rawBody);
      } catch {
        return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
      }
    } else if (typeof req.json === "function") {
      body = await req.json();
    } else {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const rawEmail = body.email;
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

    // Sanitize source (max 50 chars, alphanumeric, hyphens, and underscores)
    const rawSource = typeof body.source === "string" ? body.source : "web_form";
    const signupSource = rawSource.slice(0, 50).replace(/[^a-zA-Z0-9_-]/g, "") || "web_form";

    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent") || "unknown";

    // 2. IP Rate Limiting (max 15 signups per 10 minutes per IP) with failClosed policy on abuse endpoints
    const ipRateLimit = await checkRateLimit(
      pseudonymizeRateLimitKey("signup:ip", clientIp),
      15,
      600,
      { failClosed: true }
    );
    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many signup requests. Please wait a few minutes before trying again." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds || 60) } }
      );
    }

    // 3. Email Cooldown (max 1 confirmation request per 60 seconds per email) with failClosed policy
    const emailCooldown = await checkEmailCooldown(email, 60, { failClosed: true });
    if (!emailCooldown.allowed) {
      return NextResponse.json(
        {
          message:
            "A verification link was recently dispatched to your inbox. Please check your spam folder or wait a moment before requesting another.",
        },
        { status: 200 }
      );
    }

    // 4. ATOMIC TRANSACTION: Check suppression, persist subscriber, consent audit log, and confirmation outbox job together
    const txResult = await db.transaction(async (tx) => {
      // Step A: Check suppression inside transaction to avoid race condition with concurrent unsubscribe/bounce
      const [suppressed] = await tx
        .select({ id: suppressions.id, reason: suppressions.reason })
        .from(suppressions)
        .where(eq(suppressions.email, email));

      if (suppressed) {
        return { isSuppressed: true };
      }

      // Step B: Check existing subscriber record
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

    if (txResult.isSuppressed) {
      return NextResponse.json(
        {
          error:
            "This email address cannot receive updates due to an existing suppression or delivery failure record.",
        },
        { status: 400 }
      );
    }

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
    return NextResponse.json(
      {
        error: "Subscription service temporarily unavailable. Please try again shortly.",
      },
      { status: 503 }
    );
  }
}

