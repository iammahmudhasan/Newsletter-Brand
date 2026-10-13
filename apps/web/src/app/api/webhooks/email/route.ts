import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, suppressions, emailEvents, eq, and } from "@ai-signal/db";
import { normalizeEmail, config } from "@ai-signal/config";
import crypto from "crypto";

/**
 * Verifies Resend / Svix webhook signature
 */
function verifyResendSvixSignature(
  rawBody: string,
  secret: string,
  headers: Headers
): boolean {
  try {
    const svixId = headers.get("svix-id") || "";
    const svixTimestamp = headers.get("svix-timestamp") || "";
    const svixSignature = headers.get("svix-signature") || headers.get("x-resend-signature") || "";

    if (!svixSignature) return false;

    // Secret can be base64-encoded if prefixed with whsec_
    const secretKey = secret.startsWith("whsec_")
      ? Buffer.from(secret.slice(6), "base64")
      : Buffer.from(secret, "utf-8");

    // Check timestamp tolerance (max 5 minutes)
    if (svixTimestamp) {
      const timestampSec = parseInt(svixTimestamp, 10);
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - timestampSec) > 300) {
        return false; // Replay attack prevention
      }
    }

    const toSign = svixId && svixTimestamp ? `${svixId}.${svixTimestamp}.${rawBody}` : rawBody;
    const computed = crypto
      .createHmac("sha256", secretKey)
      .update(toSign)
      .digest("base64");

    // Signatures can be comma-separated v1,... list in Svix
    const passedSigs = svixSignature
      .split(" ")
      .flatMap((s) => s.split(","))
      .map((s) => s.replace(/^v1=/, "").trim());

    for (const sig of passedSigs) {
      const sigBuffer = Buffer.from(sig);
      const computedBuffer = Buffer.from(computed);
      if (
        sigBuffer.length === computedBuffer.length &&
        crypto.timingSafeEqual(sigBuffer, computedBuffer)
      ) {
        return true;
      }
    }

    // Fallback: standard hex HMAC comparison
    const computedHex = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    const passedHex = svixSignature.replace(/^v1=/, "").trim();
    const hexBuffer = Buffer.from(passedHex);
    const computedHexBuffer = Buffer.from(computedHex);

    if (
      hexBuffer.length === computedHexBuffer.length &&
      crypto.timingSafeEqual(hexBuffer, computedHexBuffer)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Verifies AWS SNS webhook message signature / token
 */
function verifyAwsSnsSignature(payload: any, headers: Headers, secret: string): boolean {
  // If a shared token or secret header is configured for SES/SNS HTTPS subscription
  const tokenHeader = headers.get("x-amz-sns-token") || headers.get("x-webhook-secret");
  if (tokenHeader && tokenHeader === secret) {
    return true;
  }

  // Basic validation that SNS message has required structure
  if (payload.Type && (payload.Type === "Notification" || payload.Type === "SubscriptionConfirmation")) {
    if (payload.TopicArn && payload.MessageId) {
      return true;
    }
  }

  return false;
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const isProduction = process.env.NODE_ENV === "production";
    const webhookSecret = config.email.webhookSecret;

    const signatureHeader =
      req.headers.get("svix-signature") ||
      req.headers.get("x-resend-signature") ||
      req.headers.get("x-webhook-signature") ||
      req.headers.get("x-amz-sns-message-type");

    // In production, signature or SNS authentication header is MANDATORY
    if (isProduction) {
      if (!signatureHeader) {
        return NextResponse.json(
          { error: "Unauthorized: Missing required webhook signature header" },
          { status: 401 }
        );
      }

      if (!webhookSecret || webhookSecret === "dev-webhook-secret") {
        return NextResponse.json(
          { error: "Server misconfiguration: EMAIL_WEBHOOK_SECRET is not configured" },
          { status: 500 }
        );
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
    }

    // Determine provider & verify signature
    const isAwsSns = payload.Type === "Notification" || payload.Type === "SubscriptionConfirmation";

    // Whenever a signature is supplied or secret is configured, strictly enforce signature verification
    if (signatureHeader || (webhookSecret && isProduction)) {
      let isSignatureValid = false;
      if (isAwsSns) {
        isSignatureValid = verifyAwsSnsSignature(payload, req.headers, webhookSecret);
      } else {
        isSignatureValid = verifyResendSvixSignature(rawBody, webhookSecret, req.headers);
      }

      if (!isSignatureValid) {
        return NextResponse.json(
          { error: "Unauthorized: Invalid webhook signature" },
          { status: 401 }
        );
      }
    }

    // Handle AWS SNS Subscription Confirmation
    if (payload.Type === "SubscriptionConfirmation" && payload.SubscribeURL) {
      console.log(`[Webhook SES/SNS] Subscription confirmation URL received: ${payload.SubscribeURL}`);
      return NextResponse.json({ success: true, message: "Subscription confirmation acknowledged" });
    }

    // If it's an SNS Notification wrapping an SES event, unwrap the Message string
    let eventData = payload;
    if (isAwsSns && typeof payload.Message === "string") {
      try {
        eventData = JSON.parse(payload.Message);
      } catch {
        eventData = payload;
      }
    }

    // Parse event details accurately
    let eventType = "unknown";
    let recipientEmail: string | null = null;
    let providerMessageId: string | null = null;
    let isHardBounce = false;
    let isSoftBounce = false;

    // 1. Resend structure
    if (eventData.type && typeof eventData.type === "string") {
      eventType = eventData.type;
      recipientEmail = eventData.data?.to?.[0] || eventData.data?.email || null;
      providerMessageId = eventData.data?.email_id || eventData.id || null;

      if (eventType === "email.bounced") {
        const bounceType = eventData.data?.bounce?.type || "";
        if (bounceType.toLowerCase() === "permanent" || bounceType.toLowerCase() === "hard") {
          isHardBounce = true;
        } else {
          isSoftBounce = true;
        }
      }
    }
    // 2. AWS SES structure
    else if (eventData.eventType || eventData.notificationType) {
      const sesType = eventData.eventType || eventData.notificationType;
      providerMessageId = eventData.mail?.messageId || null;

      if (sesType === "Bounce") {
        eventType = "email.bounced";
        recipientEmail = eventData.bounce?.bouncedRecipients?.[0]?.emailAddress || null;
        const sesBounceType = eventData.bounce?.bounceType || "";
        if (sesBounceType === "Permanent") {
          isHardBounce = true;
        } else {
          isSoftBounce = true; // Transient bounce
        }
      } else if (sesType === "Complaint") {
        eventType = "email.complained";
        recipientEmail = eventData.complaint?.complainedRecipients?.[0]?.emailAddress || null;
      } else if (sesType === "Delivery") {
        eventType = "email.delivered";
        recipientEmail = eventData.delivery?.recipients?.[0] || null;
      } else {
        eventType = sesType.toLowerCase();
        recipientEmail = eventData.mail?.destination?.[0] || null;
      }
    }

    if (!recipientEmail) {
      return NextResponse.json({ received: true, note: "No recipient detected in payload" }, { status: 200 });
    }

    const email = normalizeEmail(recipientEmail);

    // Standardize event type
    const standardizedType = eventType.includes("bounce")
      ? "bounce"
      : eventType.includes("complaint")
      ? "complaint"
      : eventType.includes("click")
      ? "click"
      : eventType.includes("open")
      ? "open"
      : eventType.includes("deliver")
      ? "delivered"
      : "delivered";

    // Database Idempotency Check: prevent duplicate event processing
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

    // Log event in audit table
    try {
      await db.insert(emailEvents).values({
        providerMessageId,
        recipientEmail: email,
        eventType: standardizedType,
        payload: eventData,
      });
    } catch (e: any) {
      console.warn("[Webhook] Failed to insert email event log:", e.message);
    }

    // Process Hard Bounce: suppress permanently
    if (standardizedType === "bounce") {
      if (isHardBounce) {
        console.warn(`[Webhook] Permanent hard bounce detected for ${email}. Suppressing.`);
        await db
          .update(subscribers)
          .set({ status: "bounced" })
          .where(eq(subscribers.email, email));

        await db
          .insert(suppressions)
          .values({
            email,
            reason: "hard_bounce",
            details: JSON.stringify(eventData.bounce || eventData.data?.bounce || "Permanent delivery failure"),
          })
          .onConflictDoNothing();
      } else if (isSoftBounce) {
        console.log(`[Webhook] Transient/soft bounce recorded for ${email}. Subscriber retained.`);
      }
    }

    // Process Spam Complaint: suppress immediately
    if (standardizedType === "complaint") {
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
