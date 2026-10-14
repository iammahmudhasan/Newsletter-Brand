import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, suppressions, emailEvents, campaignRecipients, campaigns, eq, and, sql } from "@ai-signal/db";
import { normalizeEmail, config } from "@ai-signal/config";
import crypto from "crypto";
import { verifyAwsSnsSignature, confirmSnsSubscription } from "@/lib/sns";

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

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const isProduction = process.env.NODE_ENV === "production";
    const webhookSecret = config.email.webhookSecret;

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
    }

    const isAwsSns =
      payload.Type === "Notification" ||
      payload.Type === "SubscriptionConfirmation" ||
      req.headers.has("x-amz-sns-message-type");

    if (isAwsSns) {
      const allowedTopicArn = config.email.aws.snsTopicArn || (isProduction ? "" : (payload.TopicArn as string) || "");
      if (isProduction && !config.email.aws.snsTopicArn) {
        console.error("[Webhook Security] AWS_SNS_TOPIC_ARN is not configured in production");
        return NextResponse.json(
          { error: "Server misconfiguration: AWS_SNS_TOPIC_ARN is not configured" },
          { status: 500 }
        );
      }

      // 1. Strictly verify AWS SNS cryptographic signature and TopicArn
      const snsResult = await verifyAwsSnsSignature(payload, {
        allowedTopicArn,
      });

      if (!snsResult.valid) {
        console.warn(`[Webhook Security] Rejected illegitimate AWS SNS notification: ${snsResult.error}`);
        return NextResponse.json(
          { error: `Unauthorized: ${snsResult.error || "Invalid AWS SNS signature"}` },
          { status: 401 }
        );
      }
    } else {
      // 2. Strictly verify Resend Svix signature
      const svixSignatureHeader =
        req.headers.get("svix-signature") ||
        req.headers.get("x-resend-signature") ||
        req.headers.get("x-webhook-signature");

      if (isProduction && !svixSignatureHeader) {
        return NextResponse.json(
          { error: "Unauthorized: Missing required webhook signature header" },
          { status: 401 }
        );
      }

      if (svixSignatureHeader || (webhookSecret && isProduction)) {
        if (!webhookSecret || (isProduction && webhookSecret === "dev-webhook-secret")) {
          return NextResponse.json(
            { error: "Server misconfiguration: EMAIL_WEBHOOK_SECRET is not configured" },
            { status: 500 }
          );
        }

        const isSignatureValid = verifyResendSvixSignature(rawBody, webhookSecret, req.headers);
        if (!isSignatureValid) {
          return NextResponse.json(
            { error: "Unauthorized: Invalid webhook signature" },
            { status: 401 }
          );
        }
      }
    }

    // 3. Handle AWS SNS Subscription Confirmation (complete verification via SDK or verified URL)
    if (payload.Type === "SubscriptionConfirmation") {
      const confirmResult = await confirmSnsSubscription({
        TopicArn: payload.TopicArn,
        Token: payload.Token,
        SubscribeURL: payload.SubscribeURL,
      });

      if (!confirmResult.success) {
        console.error(`[Webhook SES/SNS] Failed to confirm subscription: ${confirmResult.error}`);
        return NextResponse.json(
          { error: `Failed to confirm SNS subscription: ${confirmResult.error}` },
          { status: 500 }
        );
      }

      console.log(
        `[Webhook SES/SNS] Subscription confirmed successfully! SubscriptionArn: ${confirmResult.subscriptionArn || "verified"}`
      );
      return NextResponse.json(
        {
          success: true,
          message: "AWS SNS subscription confirmed successfully",
          subscriptionArn: confirmResult.subscriptionArn,
        },
        { status: 200 }
      );
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
    let providerEventId: string | null = null;
    let campaignIdTag: string | null = null;
    let recipientIdTag: string | null = null;
    let isHardBounce = false;
    let isSoftBounce = false;

    // 1. Resend structure
    if (eventData.type && typeof eventData.type === "string") {
      eventType = eventData.type;
      recipientEmail = eventData.data?.to?.[0] || eventData.data?.email || null;
      providerMessageId = eventData.data?.email_id || eventData.id || null;
      providerEventId = eventData.id || eventData.data?.id || req.headers.get("svix-id") || null;

      if (Array.isArray(eventData.data?.tags)) {
        const foundRecipient = eventData.data.tags.find((t: any) => t.name === "recipient_id");
        if (foundRecipient) recipientIdTag = foundRecipient.value;
        const foundCampaign = eventData.data.tags.find((t: any) => t.name === "campaign_id");
        if (foundCampaign) campaignIdTag = foundCampaign.value;
      }

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
      providerEventId = payload.MessageId || eventData.mail?.messageId || null;

      // Check SES message tags
      if (eventData.mail?.tags?.recipient_id) {
        const tagVal = eventData.mail.tags.recipient_id;
        recipientIdTag = Array.isArray(tagVal) ? tagVal[0] : tagVal;
      }
      if (eventData.mail?.tags?.campaign_id) {
        const cTagVal = eventData.mail.tags.campaign_id;
        campaignIdTag = Array.isArray(cTagVal) ? cTagVal[0] : cTagVal;
      }

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

    // Standardize event type with explicit allowlist (never default to "delivered"!)
    const lowerEventType = eventType.toLowerCase();
    const standardizedType: "delivered" | "bounce" | "complaint" | "click" | "open" | "unknown" =
      lowerEventType.includes("bounce")
        ? "bounce"
        : lowerEventType.includes("complain")
        ? "complaint"
        : lowerEventType.includes("click")
        ? "click"
        : lowerEventType.includes("open")
        ? "open"
        : lowerEventType.includes("deliver")
        ? "delivered"
        : "unknown";

    // 4. ATOMIC TRANSACTION: Event logging, suppression updates, and campaign recipient reconciliation
    // Wrapping in a single ACID transaction ensures that if suppression or status updates fail,
    // the event insert rolls back, allowing provider retries to re-attempt suppression processing!
    const txResult = await db.transaction(async (tx) => {
      // Step A: Idempotency check with ON CONFLICT DO NOTHING on providerEventId
      if (providerEventId) {
        const inserted = await tx
          .insert(emailEvents)
          .values({
            providerEventId,
            providerMessageId,
            campaignId: campaignIdTag,
            recipientId: recipientIdTag,
            recipientEmail: email,
            eventType: standardizedType,
            payload: eventData,
          })
          .onConflictDoNothing({
            target: emailEvents.providerEventId,
          })
          .returning({ id: emailEvents.id });

        if (inserted.length === 0) {
          // Event was ALREADY successfully processed in a committed transaction
          return { isDuplicate: true };
        }
      } else {
        await tx.insert(emailEvents).values({
          providerEventId: null,
          providerMessageId,
          campaignId: campaignIdTag,
          recipientId: recipientIdTag,
          recipientEmail: email,
          eventType: standardizedType,
          payload: eventData,
        });
      }

      // Step B: Reconcile campaign recipient status strictly based on event type
      // Supports recipientIdTag or fallback to providerMessageId
      // CRITICAL: Delayed webhooks can reconcile ambiguous outcomes held in 'needs_review'!
      const targetCondition = recipientIdTag
        ? eq(campaignRecipients.id, recipientIdTag)
        : providerMessageId
        ? eq(campaignRecipients.providerMessageId, providerMessageId)
        : null;

      if (targetCondition) {
        if (standardizedType === "delivered") {
          // Delivered transitions from queued/processing/sent/unknown_outcome/needs_review -> delivered
          // CRITICAL: NEVER overwrite terminal bounce or failed status!
          const updatedRows = await tx
            .update(campaignRecipients)
            .set({
              status: "delivered",
              providerMessageId: providerMessageId || undefined,
              sentAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                targetCondition,
                sql`${campaignRecipients.status} IN ('queued', 'processing', 'sent', 'unknown_outcome', 'needs_review')`
              )
            )
            .returning({
              id: campaignRecipients.id,
              campaignId: campaignRecipients.campaignId,
            });

          // If a recipient transitioned to delivered, reconcile the parent campaign's final delivery metrics
          if (updatedRows.length > 0) {
            const targetCampaignId = campaignIdTag || updatedRows[0].campaignId;
            if (targetCampaignId) {
              const allRecipients = await tx
                .select({ status: campaignRecipients.status })
                .from(campaignRecipients)
                .where(eq(campaignRecipients.campaignId, targetCampaignId));

              if (allRecipients.length > 0) {
                const total = allRecipients.length;
                const sent = allRecipients.filter((r) => r.status === "sent" || r.status === "delivered").length;
                const failed = allRecipients.filter(
                  (r) => r.status === "failed" || r.status === "bounced" || r.status === "needs_review"
                ).length;

                let finalCampaignStatus: "sent" | "partially_failed" | "failed" = "sent";
                if (failed > 0 && sent > 0) {
                  finalCampaignStatus = "partially_failed";
                } else if (failed > 0 && sent === 0) {
                  finalCampaignStatus = "failed";
                }

                await tx
                  .update(campaigns)
                  .set({
                    successfulSends: sent,
                    failedSends: failed,
                    status: finalCampaignStatus,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(campaigns.id, targetCampaignId),
                      sql`${campaigns.status} IN ('sent', 'partially_failed', 'failed')`
                    )
                  );
              }
            }
          }
        } else if (standardizedType === "bounce") {
          // Bounce transitions any non-bounced state to bounced
          await tx
            .update(campaignRecipients)
            .set({
              status: "bounced",
              errorMessage: isHardBounce ? "Permanent hard bounce" : "Soft bounce / mailbox full",
              updatedAt: new Date(),
            })
            .where(
              and(
                targetCondition,
                sql`${campaignRecipients.status} != 'bounced'`
              )
            );
        } else if (standardizedType === "complaint") {
          // Complaint transitions to failed
          await tx
            .update(campaignRecipients)
            .set({
              status: "failed",
              errorMessage: "Spam complaint reported",
              updatedAt: new Date(),
            })
            .where(
              and(
                targetCondition,
                sql`${campaignRecipients.status} != 'failed'`
              )
            );
        } else if (standardizedType === "open" || standardizedType === "click") {
          // Open or click confirms receipt without overriding terminal bounce/failed status
          await tx
            .update(campaignRecipients)
            .set({
              status: "delivered",
              providerMessageId: providerMessageId || undefined,
              updatedAt: new Date(),
            })
            .where(
              and(
                targetCondition,
                sql`${campaignRecipients.status} IN ('queued', 'processing', 'sent', 'unknown_outcome', 'needs_review')`
              )
            );
        }
      }

      // Step C: Process Hard Bounce: suppress permanently
      if (standardizedType === "bounce") {
        if (isHardBounce) {
          console.warn(`[Webhook] Permanent hard bounce detected for ${email}. Suppressing.`);
          await tx
            .update(subscribers)
            .set({ status: "bounced" })
            .where(eq(subscribers.email, email));

          await tx
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

      // Step D: Process Spam Complaint: suppress immediately
      if (standardizedType === "complaint") {
        console.warn(`[Webhook] Spam complaint reported for ${email}. Suppressing immediately.`);
        await tx
          .update(subscribers)
          .set({ status: "complained" })
          .where(eq(subscribers.email, email));

        await tx
          .insert(suppressions)
          .values({
            email,
            reason: "complaint",
            details: "Spam complaint received from ISP / mailbox provider",
          })
          .onConflictDoNothing();
      }

      return { isDuplicate: false };
    });

    if (txResult.isDuplicate) {
      return NextResponse.json(
        { received: true, duplicate: true, note: "Event already processed in previous transaction" },
        { status: 200 }
      );
    }

    if (standardizedType === "unknown") {
      console.warn(`[Webhook] Recorded unclassified or unknown event type '${eventType}' for ${email}`);
      return NextResponse.json(
        { received: true, unhandledType: eventType, note: "Unknown event type recorded without state modification" },
        { status: 200 }
      );
    }

    return NextResponse.json({ success: true, processed: true }, { status: 200 });
  } catch (err: any) {
    console.error("[Webhook Error]:", err.message);
    return NextResponse.json({ error: "Webhook processing failure" }, { status: 500 });
  }
}
