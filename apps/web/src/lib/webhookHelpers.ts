import { campaignRecipients, campaigns, eq, and, sql } from "@ai-signal/db";

export type WebhookNormalizedType =
  | "delivered"
  | "delivery_delayed"
  | "bounce"
  | "complaint"
  | "failed"
  | "click"
  | "open"
  | "unknown";

/**
 * Normalizes email provider webhook event types using explicit mapping.
 * Prevents substring false matches (e.g. delivery_delayed or DeliveryDelay matching 'deliver').
 */
export function normalizeWebhookEventType(rawType: string): WebhookNormalizedType {
  if (!rawType || typeof rawType !== "string") return "unknown";
  const lower = rawType.trim().toLowerCase();

  // 1. Delivery delay (SES: DeliveryDelay, Resend: email.delivery_delayed)
  if (
    lower === "deliverydelay" ||
    lower === "delivery_delay" ||
    lower === "email.delivery_delayed" ||
    lower === "delivery_delayed" ||
    lower.includes("delay")
  ) {
    return "delivery_delayed";
  }

  // 2. Successful delivery (SES: Delivery, Resend: email.delivered)
  if (
    lower === "delivery" ||
    lower === "email.delivered" ||
    lower === "delivered"
  ) {
    return "delivered";
  }

  // 3. Bounce (SES: Bounce, Resend: email.bounced)
  if (lower === "bounce" || lower === "email.bounced" || lower.includes("bounce")) {
    return "bounce";
  }

  // 4. Complaint (SES: Complaint, Resend: email.complained)
  if (lower === "complaint" || lower === "email.complained" || lower.includes("complain")) {
    return "complaint";
  }

  // 5. Terminal failures (SES: Reject, Rendering Failure; Resend: email.failed, email.suppressed)
  if (
    lower === "reject" ||
    lower === "rendering failure" ||
    lower === "renderingfailure" ||
    lower === "email.failed" ||
    lower === "email.suppressed" ||
    lower === "failed" ||
    lower === "suppressed"
  ) {
    return "failed";
  }

  // 6. Engagement events
  if (lower === "open" || lower === "email.opened" || lower === "opened" || lower.includes("open")) {
    return "open";
  }
  if (lower === "click" || lower === "email.clicked" || lower === "clicked" || lower.includes("click")) {
    return "click";
  }

  return "unknown";
}

/**
 * Recomputes and updates parent campaign aggregate metrics (successfulSends, failedSends, status)
 * after any terminal recipient state transition (delivered, bounce, complaint, failed).
 */
export async function reconcileCampaignMetrics(tx: any, campaignId: string): Promise<void> {
  if (!campaignId) return;

  const allRecipients = await tx
    .select({ status: campaignRecipients.status })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId));

  if (!allRecipients || allRecipients.length === 0) return;

  const sent = allRecipients.filter((r: any) => r.status === "sent" || r.status === "delivered").length;
  const failed = allRecipients.filter(
    (r: any) => r.status === "failed" || r.status === "bounced" || r.status === "needs_review"
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
        eq(campaigns.id, campaignId),
        sql`${campaigns.status} IN ('sent', 'partially_failed', 'failed', 'sending')`
      )
    );
}
