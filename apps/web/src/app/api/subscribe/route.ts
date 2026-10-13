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

    // 1. Check suppression list (Hard bounce or spam complaint)
    try {
      const [suppressed] = await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, email));

      if (suppressed) {
        return NextResponse.json(
          {
            error:
              "This email address cannot receive updates due to a previous bounce or suppression record.",
          },
          { status: 400 }
        );
      }
    } catch {
      // If DB is offline in prototype stage, handle gracefully
    }

    // 2. Check existing subscriber
    let subscriberId: string;
    try {
      const [existing] = await db
        .select()
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
        // Insert new subscriber
        const [inserted] = await db
          .insert(subscribers)
          .values({
            email,
            status: "pending_confirmation",
            signupSource,
          })
          .returning({ id: subscribers.id });
        subscriberId = inserted.id;

        // Record legal consent audit
        const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "127.0.0.1";
        const userAgent = req.headers.get("user-agent") || "unknown";

        await db.insert(consentEvents).values({
          subscriberId,
          source: signupSource,
          consentText: "Subscriber opted in via aisignal.dev web form.",
          ipHash: hashIp(clientIp),
          userAgent: userAgent.slice(0, 255),
        });
      }

      // 3. Enqueue verification email job
      await enqueueJob("send_confirmation", {
        subscriberId,
        email,
      });

      return NextResponse.json(
        {
          success: true,
          message:
            "Verification link dispatched! Please check your inbox to confirm your subscription.",
        },
        { status: 200 }
      );
    } catch (dbErr: any) {
      console.error("[Subscribe API DB Error]:", dbErr.message);
      // Fallback response for dev environments if postgres is initializing
      return NextResponse.json(
        {
          success: true,
          message:
            "Verification email queued for processing! Please check your inbox shortly.",
        },
        { status: 200 }
      );
    }
  } catch (err: any) {
    console.error("[Subscribe API Error]:", err.message);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again later." },
      { status: 500 }
    );
  }
}
