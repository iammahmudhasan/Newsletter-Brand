import {
  db,
  campaigns,
  subscribers,
  suppressions,
  campaignRecipients,
  eq,
  and,
  sql,
} from "@ai-signal/db";
import { getEmailProvider, renderNewsletterEmail } from "@ai-signal/email";
import { config, generateSignedToken, normalizeEmail } from "@ai-signal/config";

export async function handleProcessCampaignBatch(payload: { campaignId: string }) {
  const { campaignId } = payload;
  const provider = getEmailProvider();

  // 1. Fetch campaign
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));

  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  if (campaign.status === "sent" || campaign.status === "cancelled") {
    console.log(`[Worker] Campaign ${campaignId} is ${campaign.status}, skipping duplicate dispatch.`);
    return;
  }

  // Ensure campaign status is 'sending'
  if (campaign.status !== "sending") {
    await db
      .update(campaigns)
      .set({ status: "sending", updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));
  }

  // 2. Fetch all currently active subscribers
  const activeSubscribers = await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
    })
    .from(subscribers)
    .where(eq(subscribers.status, "active"));

  if (activeSubscribers.length === 0) {
    console.log(`[Worker] No active subscribers found for Campaign '${campaign.title}'.`);
    await db
      .update(campaigns)
      .set({
        status: "sent",
        sentAt: new Date(),
        totalRecipients: 0,
        successfulSends: 0,
        failedSends: 0,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));
    return;
  }

  // 3. Pre-populate campaignRecipients with 'queued' state (idempotent ON CONFLICT)
  for (const sub of activeSubscribers) {
    await db
      .insert(campaignRecipients)
      .values({
        campaignId: campaign.id,
        subscriberId: sub.id,
        status: "queued",
      })
      .onConflictDoNothing();
  }

  // 4. Fetch list of recipients to process
  const pendingRecipients = await db
    .select({
      recipientId: campaignRecipients.id,
      subscriberId: campaignRecipients.subscriberId,
      status: campaignRecipients.status,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        sql`${campaignRecipients.status} IN ('queued', 'failed')`
      )
    );

  console.log(
    `[Worker] Processing Campaign '${campaign.title}' (${pendingRecipients.length} pending recipient slots)`
  );

  let successCount = 0;
  let failCount = 0;

  for (const item of pendingRecipients) {
    // Atomic Claim: Transition status from 'queued' -> 'processing' to prevent race conditions
    const claimResult = await db.execute<typeof campaignRecipients.$inferSelect>(
      sql`
        UPDATE campaign_recipients
        SET status = 'processing'
        WHERE id = ${item.recipientId}
          AND status IN ('queued', 'failed')
        RETURNING *;
      `
    );

    const claimed = (claimResult as any)?.[0];
    if (!claimed) {
      // Already claimed by another worker or already marked 'sent'
      continue;
    }

    try {
      // Fresh check of subscriber status and suppression list immediately prior to dispatch
      const [freshSub] = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.id, item.subscriberId));

      if (!freshSub || freshSub.status !== "active") {
        await db
          .update(campaignRecipients)
          .set({
            status: "failed",
            errorMessage: `Subscriber not in active state (currently: ${freshSub?.status || "deleted"})`,
          })
          .where(eq(campaignRecipients.id, item.recipientId));
        failCount++;
        continue;
      }

      const normalizedEmail = normalizeEmail(freshSub.email);
      const [suppressed] = await db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(eq(suppressions.email, normalizedEmail));

      if (suppressed) {
        await db
          .update(campaignRecipients)
          .set({
            status: "failed",
            errorMessage: "Recipient email is currently on the suppression list",
          })
          .where(eq(campaignRecipients.id, item.recipientId));
        failCount++;
        continue;
      }

      // Generate signed unsubscribe tokens with purpose: 'unsubscribe'
      const unsubToken = generateSignedToken(
        {
          id: freshSub.id,
          email: freshSub.email,
          purpose: "unsubscribe",
        },
        365 * 86400
      );

      const unsubscribeWebUrl = `${config.appUrl}/unsubscribe?token=${unsubToken}`;
      const unsubscribeApiUrl = `${config.appUrl}/api/unsubscribe?token=${unsubToken}`;
      const archiveUrl = `${config.appUrl}/archive/${campaign.id}`;

      const { html, text, headers } = renderNewsletterEmail({
        issueNumber: 1,
        issueDate: new Date().toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        title: campaign.title,
        previewText: campaign.previewText || "",
        htmlContent: campaign.contentHtml,
        recipientEmail: freshSub.email,
        unsubscribeWebUrl,
        unsubscribeApiUrl,
        archiveUrl,
      });

      const sendResult = await provider.sendEmail({
        to: freshSub.email,
        subject: campaign.subject,
        html,
        text,
        headers,
      });

      if (sendResult.success) {
        successCount++;
        await db
          .update(campaignRecipients)
          .set({
            status: "sent",
            providerMessageId: sendResult.messageId,
            sentAt: new Date(),
            errorMessage: null,
          })
          .where(eq(campaignRecipients.id, item.recipientId));
      } else {
        failCount++;
        await db
          .update(campaignRecipients)
          .set({
            status: "failed",
            errorMessage: sendResult.error || "Email provider dispatch failed",
          })
          .where(eq(campaignRecipients.id, item.recipientId));
      }
    } catch (sendErr: any) {
      failCount++;
      console.error(`[Worker] Send exception for subscriber ${item.subscriberId}:`, sendErr.message);
      await db
        .update(campaignRecipients)
        .set({
          status: "failed",
          errorMessage: sendErr.message || "Unexpected exception during dispatch",
        })
        .where(eq(campaignRecipients.id, item.recipientId));
    }
  }

  // 5. Calculate accurate final campaign status
  const allRecipients = await db
    .select({ status: campaignRecipients.status })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id));

  const total = allRecipients.length;
  const sent = allRecipients.filter((r) => r.status === "sent").length;
  const failed = allRecipients.filter((r) => r.status === "failed").length;

  let finalCampaignStatus: "sent" | "partially_failed" | "failed" = "sent";
  if (failed > 0 && sent > 0) {
    finalCampaignStatus = "partially_failed";
  } else if (failed > 0 && sent === 0) {
    finalCampaignStatus = "failed";
  }

  await db
    .update(campaigns)
    .set({
      status: finalCampaignStatus,
      sentAt: new Date(),
      totalRecipients: total,
      successfulSends: sent,
      failedSends: failed,
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));

  console.log(
    `[Worker] Campaign '${campaign.title}' dispatch finalized with status '${finalCampaignStatus}'. Sent: ${sent}, Failed: ${failed}, Total: ${total}.`
  );
}
