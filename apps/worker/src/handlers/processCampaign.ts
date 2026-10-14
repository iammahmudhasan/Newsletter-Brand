import {
  db,
  campaigns,
  subscribers,
  suppressions,
  campaignRecipients,
  emailEvents,
  eq,
  and,
  sql,
} from "@ai-signal/db";
import { getEmailProvider, renderNewsletterEmail } from "@ai-signal/email";
import { config, generateSignedToken, normalizeEmail } from "@ai-signal/config";
import { enqueueJob, renewJobLease } from "@ai-signal/queue";

export async function handleProcessCampaignBatch(
  payload: { campaignId: string },
  jobId?: string
) {
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

  // 4. Fetch list of recipients to process (including retryable queued items and expired processing leases)
  const pendingRecipients = await db
    .select({
      recipientId: campaignRecipients.id,
      subscriberId: campaignRecipients.subscriberId,
      status: campaignRecipients.status,
      attemptCount: campaignRecipients.attemptCount,
      providerMessageId: campaignRecipients.providerMessageId,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        sql`(
          (${campaignRecipients.status} = 'queued' AND (${campaignRecipients.nextAttemptAt} IS NULL OR ${campaignRecipients.nextAttemptAt} <= NOW()))
          OR (${campaignRecipients.status} IN ('processing', 'unknown_outcome') AND ${campaignRecipients.updatedAt} < NOW() - INTERVAL '5 minutes')
        )`
      )
    );

  console.log(
    `[Worker] Processing Campaign '${campaign.title}' (${pendingRecipients.length} eligible recipient slots)`
  );

  let successCount = 0;
  let failCount = 0;
  const BATCH_SIZE = 50;
  const MAX_RECIPIENT_ATTEMPTS = 3;

  for (let i = 0; i < pendingRecipients.length; i += BATCH_SIZE) {
    const batch = pendingRecipients.slice(i, i + BATCH_SIZE);

    // Heartbeat: renew job lock lease in queue so long campaigns never get falsely reclaimed as stale
    if (jobId) {
      await renewJobLease(jobId);
    }

    // Touch campaign updatedAt to record active progress
    await db
      .update(campaigns)
      .set({ updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));

    for (const item of batch) {
      // Periodic heartbeat on active worker lease
      if (jobId) {
        await renewJobLease(jobId);
      }

      // Atomic Claim: Transition status to 'processing' with fresh lease timestamp
      const claimResult = await db.execute<typeof campaignRecipients.$inferSelect>(
        sql`
          UPDATE campaign_recipients
          SET status = 'processing', updated_at = NOW()
          WHERE id = ${item.recipientId}
            AND (
              (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
              OR (status IN ('processing', 'unknown_outcome') AND updated_at < NOW() - INTERVAL '5 minutes')
            )
          RETURNING *;
        `
      );

      const claimed = (claimResult as any)?.[0];
      if (!claimed) {
        // Already claimed by another worker or already marked 'sent'/'delivered'
        continue;
      }

      // Crash Recovery Check: If providerMessageId already exists on claimed record,
      // the email was already accepted by SES/Resend before the worker crashed!
      // Do NOT duplicate send!
      if (claimed.provider_message_id) {
        console.log(`[Worker Recovery] Recipient ${claimed.id} already has providerMessageId ${claimed.provider_message_id}. Marking sent.`);
        await db
          .update(campaignRecipients)
          .set({
            status: "sent",
            sentAt: claimed.sent_at || new Date(),
            updatedAt: new Date(),
          })
          .where(eq(campaignRecipients.id, item.recipientId));
        successCount++;
        continue;
      }

      // Ambiguous Send Reconciliation: If this record was stuck in 'processing' or 'unknown_outcome',
      // check if a webhook event (SES or Resend) already recorded delivery/bounce for this recipient
      if (item.status === "processing" || item.status === "unknown_outcome") {
        const [reconciledEvent] = await db
          .select({
            providerMessageId: emailEvents.providerMessageId,
            eventType: emailEvents.eventType,
          })
          .from(emailEvents)
          .where(eq(emailEvents.recipientId, item.recipientId))
          .limit(1);

        if (reconciledEvent) {
          console.log(
            `[Worker Ambiguous Recovery] Recipient ${item.recipientId} reconciled from webhook event '${reconciledEvent.eventType}' (${reconciledEvent.providerMessageId}). Bypassing duplicate dispatch.`
          );

          let newStatus: "sent" | "delivered" | "bounced" | "failed" = "sent";
          if (reconciledEvent.eventType === "delivered") newStatus = "delivered";
          else if (reconciledEvent.eventType === "bounce") newStatus = "bounced";
          else if (reconciledEvent.eventType === "complaint") newStatus = "failed";

          await db
            .update(campaignRecipients)
            .set({
              status: newStatus,
              providerMessageId: reconciledEvent.providerMessageId || undefined,
              sentAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(campaignRecipients.id, item.recipientId));

          if (newStatus === "sent" || newStatus === "delivered") successCount++;
          else failCount++;
          continue;
        }
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
              updatedAt: new Date(),
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
              updatedAt: new Date(),
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

        // Use recipient-specific idempotency key for provider-level duplicate dispatch protection
        const idempotencyKey = `campaign:${campaign.id}:recipient:${item.recipientId}`;

        const sendResult = await provider.sendEmail({
          to: freshSub.email,
          subject: campaign.subject,
          html,
          text,
          headers,
          tags: {
            campaign_id: campaign.id,
            recipient_id: item.recipientId,
          },
          idempotencyKey,
        });

        if (sendResult.success) {
          successCount++;
          await db
            .update(campaignRecipients)
            .set({
              status: "sent",
              providerMessageId: sendResult.messageId,
              sentAt: new Date(),
              updatedAt: new Date(),
              errorMessage: null,
            })
            .where(eq(campaignRecipients.id, item.recipientId));
        } else {
          // Failure handling with Exponential Backoff Retry Policy
          const currentAttempts = (claimed.attempt_count ?? item.attemptCount ?? 0) + 1;
          const errorMsg = sendResult.error || "Email provider dispatch failed";

          const isPermanent =
            errorMsg.toLowerCase().includes("suppress") ||
            errorMsg.toLowerCase().includes("blacklisted") ||
            errorMsg.toLowerCase().includes("invalid email") ||
            errorMsg.toLowerCase().includes("does not exist");

          if (!isPermanent && currentAttempts < MAX_RECIPIENT_ATTEMPTS) {
            const backoffMinutes = currentAttempts === 1 ? 2 : 5;
            const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

            console.warn(
              `[Worker Retry Policy] Transient failure for recipient ${item.recipientId}: '${errorMsg}'. Scheduling attempt ${currentAttempts + 1}/${MAX_RECIPIENT_ATTEMPTS} for ${nextAttemptAt.toISOString()}`
            );

            await db
              .update(campaignRecipients)
              .set({
                status: "queued",
                attemptCount: currentAttempts,
                lastAttemptAt: new Date(),
                nextAttemptAt,
                errorMessage: `Attempt ${currentAttempts} failed: ${errorMsg}`,
                updatedAt: new Date(),
              })
              .where(eq(campaignRecipients.id, item.recipientId));
          } else {
            console.error(
              `[Worker Final Failure] Permanent or exhausted attempts (${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}) for recipient ${item.recipientId}: ${errorMsg}`
            );
            failCount++;
            await db
              .update(campaignRecipients)
              .set({
                status: "failed",
                attemptCount: currentAttempts,
                lastAttemptAt: new Date(),
                nextAttemptAt: null,
                errorMessage: errorMsg,
                updatedAt: new Date(),
              })
              .where(eq(campaignRecipients.id, item.recipientId));
          }
        }
      } catch (sendErr: any) {
        const currentAttempts = (claimed.attempt_count ?? item.attemptCount ?? 0) + 1;
        const errorMsg = sendErr.message || "Unexpected exception during dispatch";

        if (currentAttempts < MAX_RECIPIENT_ATTEMPTS) {
          const backoffMinutes = currentAttempts === 1 ? 2 : 5;
          const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

          console.warn(
            `[Worker Retry Policy] Network/timeout exception for recipient ${item.recipientId}: '${errorMsg}'. Scheduling retry ${currentAttempts + 1}/${MAX_RECIPIENT_ATTEMPTS} for ${nextAttemptAt.toISOString()}`
          );

          await db
            .update(campaignRecipients)
            .set({
              status: "queued",
              attemptCount: currentAttempts,
              lastAttemptAt: new Date(),
              nextAttemptAt,
              errorMessage: `Attempt ${currentAttempts} exception: ${errorMsg}`,
              updatedAt: new Date(),
            })
            .where(eq(campaignRecipients.id, item.recipientId));
        } else {
          failCount++;
          console.error(`[Worker Final Failure] Max attempts reached after exception for subscriber ${item.subscriberId}:`, errorMsg);
          await db
            .update(campaignRecipients)
            .set({
              status: "failed",
              attemptCount: currentAttempts,
              lastAttemptAt: new Date(),
              nextAttemptAt: null,
              errorMessage: errorMsg,
              updatedAt: new Date(),
            })
            .where(eq(campaignRecipients.id, item.recipientId));
        }
      }
    }

    // Refresh lease after completing each batch chunk
    if (jobId) {
      await renewJobLease(jobId);
    }
  }

  // 5. Check if any recipients are still pending or waiting for next retry attempt
  const remainingActive = await db
    .select({
      id: campaignRecipients.id,
      status: campaignRecipients.status,
      nextAttemptAt: campaignRecipients.nextAttemptAt,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
      )
    );

  if (remainingActive.length > 0) {
    const nextAttempts = remainingActive
      .map((r) => r.nextAttemptAt?.getTime())
      .filter((t): t is number => typeof t === "number" && t > Date.now());

    const earliestWakeup =
      nextAttempts.length > 0 ? new Date(Math.min(...nextAttempts)) : new Date(Date.now() + 2 * 60 * 1000);

    console.log(
      `[Worker] Campaign '${campaign.title}' still has ${remainingActive.length} active/retryable recipients. Re-scheduling queue job for ${earliestWakeup.toISOString()}.`
    );

    await enqueueJob(
      "process_campaign",
      { campaignId: campaign.id },
      {
        scheduledFor: earliestWakeup,
        idempotencyKey: `campaign:${campaign.id}:retry:${earliestWakeup.getTime()}`,
      }
    );

    await db
      .update(campaigns)
      .set({
        status: "sending",
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));
    return;
  }

  // 6. Only when ALL recipients have reached a terminal state (sent, delivered, failed, bounced):
  const allRecipients = await db
    .select({ status: campaignRecipients.status })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id));

  const total = allRecipients.length;
  const sent = allRecipients.filter((r) => r.status === "sent" || r.status === "delivered").length;
  const failed = allRecipients.filter((r) => r.status === "failed" || r.status === "bounced").length;

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
