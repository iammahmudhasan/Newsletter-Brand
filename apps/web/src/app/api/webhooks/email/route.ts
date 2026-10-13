import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, suppressions, emailEvents, eq, and } from "@ai-signal/db";
import { normalizeEmail, config } from "@ai-signal/config";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signatureHeader =
      req.headers.get("x-webhook-signature") ||
      req.headers.get("svix-signature") ||
      req.headers.get("x-resend-signature");

    // Verify webhook signature when secret is configured
    if (config.email.webhookSecret && config.email.webhookSecret !== "dev-webhook-secret" && signatureHeader) {
      const expectedSignature = crypto
        .createHmac("sha256", config.email.webhookSecret)
        .update(rawBody)
        .digest("hex");

      // Verify timing-safe match
      const providedBuffer = Buffer.from(signatureHeader.replace(/^v1=/, ""));
      const expectedBuffer = Buffer.from(expectedSignature);

      if (
        providedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
      ) {
        return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
      }
    }

    const payload = JSON.parse(rawBody);

    // Standardize event format across Resend / SES / generic payloads
    const eventType = payload.type || payload.eventType || payload.event || "unknown";
    const providerMessageId = payload.data?.email_id || payload.messageId || payload.id || null;
    const recipientEmail =
      payload.data?.to?.[0] || payload.recipient || payload.email || null;

    if (!recipientEmail) {
      return NextResponse.json({ received: true, note: "No recipient specified" }, { status: 200 });
    }

    const email = normalizeEmail(recipientEmail);
    const standardizedType = eventType.includes("bounce")
      ? "bounce"
      : eventType.includes("complaint")
      ? "complaint"
      : eventType.includes("click")
      ? "click"
      : eventType.includes("open")
      ? "open"
      : "delivered";

    // 1. Idempotency Check: protect against duplicate webhook deliveries
    if (providerMessageId) {
      const [existingEvent] = await db
        .select({ id: emailEvents.id })
        .from(emailEvents)
        .where(
          and(
            eq(emailEvents.providerMessageId, providerMessageId),
            eq(emailEvents.eventType, standardizedType)
          )
        );

      if (existingEvent) {
        return NextResponse.json(
          { received: true, duplicate: true, note: "Event already processed" },
          { status: 200 }
        );
      }
    }

    // 2. Log event in email_events table
    try {
      await db.insert(emailEvents).values({
        providerMessageId,
        recipientEmail: email,
        eventType: standardizedType,
        payload: payload,
      });
    } catch (e: any) {
      console.warn("[Webhook] Failed to insert email event log:", e.message);
    }

    // 3. Handle Hard Bounce
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

    // 4. Handle Spam Complaint
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
