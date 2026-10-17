import { campaignRecipients, campaigns, eq, and, sql } from "@ai-signal/db";

export type WebhookNormalizedType =
  | "delivered"
  | "delivery_delayed"
  | "bounce"
  | "complaint"
  | "failed"
  | "suppressed"
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

  // 5. Suppressed by provider infrastructure (Resend: email.suppressed)
  if (lower === "email.suppressed" || lower === "suppressed") {
    return "suppressed";
  }

  // 6. Terminal failures (SES: Reject, Rendering Failure; Resend: email.failed)
  if (
    lower === "reject" ||
    lower === "rendering failure" ||
    lower === "renderingfailure" ||
    lower === "email.failed" ||
    lower === "failed"
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
 * Determines the target campaign status from recipient states.
 * CRITICAL: A campaign CANNOT be transitioned to a terminal status ('sent', 'partially_failed', 'failed')
 * while any recipients are queued, being processed, or in 'unknown_outcome' awaiting reconciliation/retry.
 */
export function computeCampaignTargetStatus(
  allRecipients: { status: string }[]
): "sending" | "sent" | "partially_failed" | "failed" {
  const sent = allRecipients.filter((r: any) => r.status === "sent" || r.status === "delivered").length;
  const failed = allRecipients.filter(
    (r: any) => r.status === "failed" || r.status === "bounced" || r.status === "needs_review"
  ).length;
  const inFlightOrPending = allRecipients.filter(
    (r: any) => r.status === "queued" || r.status === "processing" || r.status === "unknown_outcome"
  ).length;

  if (inFlightOrPending > 0) {
    return "sending";
  }

  if (failed > 0 && sent > 0) {
    return "partially_failed";
  } else if (failed > 0 && sent === 0) {
    return "failed";
  } else {
    return "sent";
  }
}

/**
 * Recomputes and updates parent campaign aggregate metrics (successfulSends, failedSends, status)
 * after any terminal recipient state transition (delivered, bounce, complaint, failed).
 */
export async function reconcileCampaignMetrics(tx: any, campaignId: string): Promise<void> {
  if (!campaignId) return;

  const [currentCamp] = await tx
    .select({
      id: campaigns.id,
      status: campaigns.status,
      sentAt: campaigns.sentAt,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .for("update");

  if (!currentCamp) return;

  const allRecipients = await tx
    .select({ status: campaignRecipients.status })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId));

  if (!allRecipients || allRecipients.length === 0) return;

  const sent = allRecipients.filter((r: any) => r.status === "sent" || r.status === "delivered").length;
  const failed = allRecipients.filter(
    (r: any) => r.status === "failed" || r.status === "bounced" || r.status === "needs_review"
  ).length;
  const total = allRecipients.length;

  // CRITICAL: If campaign is cancelled, preserve status 'cancelled' while synchronizing counters
  if (currentCamp.status === "cancelled") {
    await tx
      .update(campaigns)
      .set({
        totalRecipients: total,
        successfulSends: sent,
        failedSends: failed,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.status, "cancelled")
        )
      );
    return;
  }

  const targetStatus = computeCampaignTargetStatus(allRecipients);

  await tx
    .update(campaigns)
    .set({
      totalRecipients: total,
      successfulSends: sent,
      failedSends: failed,
      status: targetStatus,
      sentAt: targetStatus !== "sending" ? sql`COALESCE(${campaigns.sentAt}, NOW())` : campaigns.sentAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(campaigns.id, campaignId),
        sql`${campaigns.status} IN ('sent', 'partially_failed', 'failed', 'sending')`
      )
    );
}
