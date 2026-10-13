import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, suppressions, emailEvents, eq } from "@ai-signal/db";
import { normalizeEmail } from "@ai-signal/config";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    // Standardize event format across Resend / SES / generic payloads
    const eventType = payload.type || payload.eventType || payload.event || "unknown";
    const providerMessageId = payload.data?.email_id || payload.messageId || payload.id || null;
    const recipientEmail =
      payload.data?.to?.[0] || payload.recipient || payload.email || null;

    if (!recipientEmail) {
      return NextResponse.json({ received: true, note: "No recipient specified" }, { status: 200 });
    }

    const email = normalizeEmail(recipientEmail);

    // 1. Log event in email_events table
    try {
      await db.insert(emailEvents).values({
        providerMessageId,
        recipientEmail: email,
        eventType: eventType.includes("bounce")
          ? "bounce"
          : eventType.includes("complaint")
          ? "complaint"
          : eventType.includes("click")
          ? "click"
          : eventType.includes("open")
          ? "open"
          : "delivered",
        payload: payload,
      });
    } catch (e: any) {
      console.warn("[Webhook] Failed to insert email event log:", e.message);
    }

    // 2. Handle Hard Bounce
    if (eventType.includes("bounce")) {
      const isHardBounce =
        payload.bounceType === "Permanent" ||
        payload.data?.bounce?.type === "hard" ||
        true;

      if (isHardBounce) {
        console.warn(`[Webhook] Hard bounce detected for ${email}. Adding to suppressions.`);
        await db
          .update(subscribers)
          .set({ status: "bounced" })
          .where(eq(subscribers.email, email));

        await db
          .insert(suppressions)
          .values({
            email,
            reason: "hard_bounce",
            details: JSON.stringify(payload.bounce || payload.data?.bounce || "Provider bounce event"),
          })
          .onConflictDoNothing();
      }
    }

    // 3. Handle Spam Complaint
    if (eventType.includes("complaint")) {
      console.warn(`[Webhook] Spam complaint reported for ${email}. Suppressing immediately.`);
      await db
        .update(subscribers)
        .set({ status: "complained" })
        .where(eq(subscribers.email, email));

      await db
        .insert(suppressions)
        .values({
          email,
          reason: "complaint",
          details: "Spam complaint received from ISP / mailbox provider",
        })
        .onConflictDoNothing();
    }

    return NextResponse.json({ success: true, processed: true }, { status: 200 });
  } catch (err: any) {
    console.error("[Webhook Error]:", err.message);
    return NextResponse.json({ error: "Webhook processing failure" }, { status: 500 });
  }
}
