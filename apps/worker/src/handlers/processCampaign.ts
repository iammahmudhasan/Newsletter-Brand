import {
  db,
  campaigns,
  subscribers,
  suppressions,
  campaignRecipients,
  emailEvents,
  eq,
  and,
  desc,
  sql,
} from "@ai-signal/db";
import { getEmailProvider, renderNewsletterEmail } from "@ai-signal/email";
import { config, generateSignedToken, normalizeEmail } from "@ai-signal/config";
import { enqueueJob, renewJobLease } from "@ai-signal/queue";
import crypto, { randomUUID } from "crypto";
import { reconcileStaleInFlightPermits } from "../scheduler/campaignScheduler";

export async function handleProcessCampaignBatch(
  payload: { campaignId: string },
  jobId?: string,
  leaseToken?: string | null
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

  // CRITICAL: Strictly abort dispatch if campaign was cancelled.
  // A cancelled campaign must NEVER be resumed, rescheduled, or have emails dispatched.
  if (campaign.status === "cancelled") {
    console.log(`[Worker] Campaign ${campaignId} is cancelled; aborting dispatch.`);
    // Cancel truly pending recipients (queued, unknown_outcome, or processing without active permit)
    await db
      .update(campaignRecipients)
      .set({
        status: "failed",
        errorMessage: "Cancelled by campaign cancellation",
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          sql`(${campaignRecipients.claimToken} IS NULL OR ${campaignRecipients.claimToken} NOT LIKE 'permit:%')`,
          sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
        )
      );
    return;
  }

  // Safety check for terminal campaigns (sent, partially_failed, failed):
  // Check if any active, queued, processing, or unknown_outcome recipients remain.
  if (["sent", "partially_failed", "failed"].includes(campaign.status)) {
    const activeRecipients = await db
      .select({
        id: campaignRecipients.id,
        status: campaignRecipients.status,
      })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
        )
      );

    if (activeRecipients.length === 0) {
      console.log(
        `[Worker] Campaign ${campaignId} has already reached terminal status '${campaign.status}' with 0 pending recipients, skipping duplicate dispatch.`
      );
      return;
    }

    // CRITICAL FIX: Terminal Campaign Recipient Reconciliation
    // A campaign in a terminal status ('sent', 'partially_failed', 'failed') must NEVER be restarted back to 'sending'
    // as that violates terminal state immutability and confuses operators and webhooks.
    // Instead, execute transactional reconciliation: transition all stranded active recipients to 'needs_review'
    // with an explicit audit errorMessage, release any claim tokens, and emit a structured operator alert.
    console.error(
      `[OPERATOR ALERT - Terminal Campaign Inconsistency] Campaign ${campaignId} is in terminal status '${campaign.status}' but has ${activeRecipients.length} stranded active recipient(s). Reconciling stranded recipients to 'needs_review'.`
    );

    await db.transaction(async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({
          status: "needs_review",
          errorMessage: `Reconciled: campaign already reached terminal status '${campaign.status}' while recipient was stranded in active state`,
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaignRecipients.campaignId, campaignId),
            sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
          )
        );

      // Re-synchronize parent campaign summary counters to match actual recipient distribution
      // while keeping campaign's terminal status immutable
      const [counts] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          sent: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('sent', 'delivered'))::int`,
          failed: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('failed', 'bounced'))::int`,
        })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaignId));

      await tx
        .update(campaigns)
        .set({
          totalRecipients: counts?.total ?? campaign.totalRecipients,
          successfulSends: counts?.sent ?? campaign.successfulSends,
          failedSends: counts?.failed ?? campaign.failedSends,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId));
    });

    return;
  }

  // 1. Atomically ensure campaign status is 'sending' and persistent firstDispatchAt is established.
  // CRITICAL: We enforce sql`${campaigns.status} IN ('scheduled', 'sending')` so an admin's cancellation
  // or a webhook's terminal transition (sent/partially_failed/failed) is NEVER overwritten back to 'sending'!
  const [initializedCampaign] = await db
    .update(campaigns)
    .set({
      status: "sending",
      firstDispatchAt: sql`COALESCE(${campaigns.firstDispatchAt}, NOW())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(campaigns.id, campaignId),
        sql`${campaigns.status} IN ('scheduled', 'sending')`
      )
    )
    .returning({
      id: campaigns.id,
      firstDispatchAt: campaigns.firstDispatchAt,
      status: campaigns.status,
    });

  if (!initializedCampaign) {
    const [fresh] = await db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    if (fresh?.status === "cancelled") {
      console.log(`[Worker] Campaign ${campaignId} initialization aborted: campaign was cancelled.`);
      // Cancel any remaining queued or unpermitted processing/unknown_outcome recipients
      await db
        .update(campaignRecipients)
        .set({
          status: "failed",
          errorMessage: "Cancelled by campaign cancellation",
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaignRecipients.campaignId, campaignId),
            sql`(${campaignRecipients.claimToken} IS NULL OR ${campaignRecipients.claimToken} NOT LIKE 'permit:%')`,
            sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
          )
        );
    } else {
      console.log(
        `[Worker] Campaign ${campaignId} initialization bypassed: campaign is already in terminal state '${fresh?.status || "unknown"}'.`
      );
    }
    return;
  }

  const firstDispatchAt: Date = initializedCampaign?.firstDispatchAt || campaign.firstDispatchAt || new Date();

  // 2. Check if this campaign already has pre-existing recipients from a previous/interrupted dispatch
  const existingRecipients = await db
    .select({ count: sql<number>`count(*)` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id));
  const existingCount = Number(existingRecipients[0]?.count || 0);

  // Fetch all currently active subscribers
  const activeSubscribers = await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
    })
    .from(subscribers)
    .where(eq(subscribers.status, "active"));

  if (activeSubscribers.length === 0 && existingCount === 0) {
    console.log(`[Worker] No active subscribers and no existing recipients found for Campaign '${campaign.title}'.`);
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
      .where(
        and(
          eq(campaigns.id, campaignId),
          sql`${campaigns.status} <> 'cancelled'`
        )
      );
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

  // 4. Stale in-flight permit reconciliation: resolve any stranded permits before fetching pending batch
  // Prevents duplicate email dispatch by moving unconfirmed stranded permits to needs_review instead of re-sending
  await reconcileStaleInFlightPermits(5);

  // Fetch list of recipients to process (including retryable queued items and expired processing leases without active permits)
  const pendingRecipients = await db
    .select({
      recipientId: campaignRecipients.id,
      subscriberId: campaignRecipients.subscriberId,
      status: campaignRecipients.status,
      attemptCount: campaignRecipients.attemptCount,
      providerMessageId: campaignRecipients.providerMessageId,
      claimToken: campaignRecipients.claimToken,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        sql`(
          (${campaignRecipients.status} = 'queued' AND (${campaignRecipients.nextAttemptAt} IS NULL OR ${campaignRecipients.nextAttemptAt} <= NOW()))
          OR (${campaignRecipients.status} = 'unknown_outcome' AND (${campaignRecipients.claimToken} IS NULL OR ${campaignRecipients.claimToken} NOT LIKE 'permit:%') AND (${campaignRecipients.nextAttemptAt} IS NULL OR ${campaignRecipients.nextAttemptAt} <= NOW()))
          OR (${campaignRecipients.status} = 'processing' AND (${campaignRecipients.claimToken} IS NULL OR ${campaignRecipients.claimToken} NOT LIKE 'permit:%') AND ${campaignRecipients.updatedAt} < NOW() - INTERVAL '5 minutes')
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

  let leaseLost = false;

  // Background heartbeat interval while worker batch is active (every 10 seconds)
  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (jobId && leaseToken) {
    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await renewJobLease(jobId, leaseToken);
        if (!renewed) {
          console.error(`[Worker Heartbeat Alert] Lost queue lease for job ${jobId}. Another worker may have reclaimed this job.`);
          leaseLost = true;
        } else {
          await db
            .update(campaigns)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(campaigns.id, campaignId),
                eq(campaigns.status, "sending")
              )
            );
        }
      } catch (err: any) {
        console.warn(`[Worker Heartbeat Warning] Failed to pulse lease for job ${jobId}:`, err.message);
      }
    }, 10000);
  }

  try {
    for (let i = 0; i < pendingRecipients.length; i += BATCH_SIZE) {
      if (leaseLost) {
        console.error(`[Worker Lease Lost] Halting campaign dispatch for '${campaign.title}' due to lost lease.`);
        break;
      }

      const batch = pendingRecipients.slice(i, i + BATCH_SIZE);

      // Heartbeat: renew job lock lease in queue so long campaigns never get falsely reclaimed as stale
      if (jobId && leaseToken) {
        const renewed = await renewJobLease(jobId, leaseToken);
        if (!renewed) {
          console.error(`[Worker Lease Lost] Failed to renew lease before batch ${i} for job ${jobId}. Halting execution.`);
          leaseLost = true;
          break;
        }
      }

      // Check if campaign was cancelled or reached terminal status concurrently
      const [currentCampaign] = await db
        .select({ status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.id, campaignId));

      if (currentCampaign?.status !== "sending") {
        console.warn(
          `[Worker Concurrency Notice] Campaign ${campaignId} is no longer in 'sending' status (currently '${currentCampaign?.status || "unknown"}'). Halting batch loop.`
        );
        break;
      }

      // Touch campaign updatedAt to record active progress
      await db
        .update(campaigns)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.status, "sending")
          )
        );

      for (const item of batch) {
        if (leaseLost) {
          console.error(`[Worker Lease Lost] Aborting dispatch of recipient ${item.recipientId} due to lost lease.`);
          break;
        }

        if (jobId && leaseToken) {
          const renewed = await renewJobLease(jobId, leaseToken);
          if (!renewed) {
            console.error(`[Worker Lease Lost] Failed to renew lease before recipient ${item.recipientId}. Halting execution.`);
            leaseLost = true;
            break;
          }
        }

        // Atomic Claim: Transition status to 'processing' with fresh lease timestamp and unique claimToken
        // Exclude any records with active or stranded permits ('permit:%') to protect against duplicate dispatch
        const claimToken = crypto.randomUUID();
        const claimResult = await db.execute<typeof campaignRecipients.$inferSelect>(
          sql`
            UPDATE campaign_recipients
            SET status = 'processing', claim_token = ${claimToken}, updated_at = NOW()
            WHERE id = ${item.recipientId}
              AND (
                (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
                OR (status = 'unknown_outcome' AND (claim_token IS NULL OR claim_token NOT LIKE 'permit:%') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
                OR (status = 'processing' AND (claim_token IS NULL OR claim_token NOT LIKE 'permit:%') AND updated_at < NOW() - INTERVAL '5 minutes')
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
          console.log(`[Worker Recovery] Recipient ${claimed.id} already has providerMessageId ${claimed.provider_message_id}. Marking sent if still processing.`);
          await db
            .update(campaignRecipients)
            .set({
              status: "sent",
              sentAt: claimed.sent_at || new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(campaignRecipients.id, item.recipientId),
                eq(campaignRecipients.status, "processing"),
                eq(campaignRecipients.claimToken, claimToken)
              )
            );
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
            .where(
              and(
                eq(emailEvents.recipientId, item.recipientId),
                sql`${emailEvents.eventType} IN ('delivered', 'bounce', 'complaint', 'failed', 'suppressed', 'open', 'click')`
              )
            )
            .orderBy(desc(emailEvents.createdAt))
            .limit(1);

          if (reconciledEvent) {
            console.log(
              `[Worker Ambiguous Recovery] Recipient ${item.recipientId} reconciled from webhook event '${reconciledEvent.eventType}' (${reconciledEvent.providerMessageId}). Bypassing duplicate dispatch.`
            );

            let newStatus: "delivered" | "bounced" | "failed" = "delivered";
            if (reconciledEvent.eventType === "bounce") {
              newStatus = "bounced";
            } else if (
              reconciledEvent.eventType === "complaint" ||
              reconciledEvent.eventType === "failed" ||
              reconciledEvent.eventType === "suppressed"
            ) {
              newStatus = "failed";
            } else {
              newStatus = "delivered";
            }

            await db
              .update(campaignRecipients)
              .set({
                status: newStatus,
                providerMessageId: reconciledEvent.providerMessageId || undefined,
                sentAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  eq(campaignRecipients.claimToken, claimToken)
                )
              );

            if (newStatus === "delivered") successCount++;
            else failCount++;
            continue;
          } else if (provider.name === "ses") {
            console.warn(
              `[SES At-Least-Once Risk] Recipient ${item.recipientId} had no webhook delivery event recorded after crash/timeout. AWS SES lacks native request deduplication; re-dispatching under at-least-once delivery semantics.`
            );
          }
        }

        let permitToken: string | null = null;
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
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  eq(campaignRecipients.claimToken, claimToken)
                )
              );
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
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  eq(campaignRecipients.claimToken, claimToken)
                )
              );
            failCount++;
            continue;
          }

          // Generate deterministic signed unsubscribe tokens using persistent firstDispatchAt as base timestamp
          // This guarantees byte-for-byte identical token and email payload across all retries!
          const baseTimestamp = Math.floor(firstDispatchAt.getTime() / 1000);
          const unsubToken = generateSignedToken(
            {
              id: freshSub.id,
              email: freshSub.email,
              purpose: "unsubscribe",
            },
            365 * 86400,
            baseTimestamp
          );

          const unsubscribeWebUrl = `${config.appUrl}/unsubscribe?token=${unsubToken}`;
          const unsubscribeApiUrl = `${config.appUrl}/api/unsubscribe?token=${unsubToken}`;
          const archiveUrl = `${config.appUrl}/archive/${campaign.id}`;

          // Format issueDate deterministically from firstDispatchAt
          const issueDate = new Date(firstDispatchAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });

          const { html, text, headers } = renderNewsletterEmail({
            issueNumber: campaign.issueNumber || 1,
            issueDate,
            title: campaign.title,
            previewText: campaign.previewText || "",
            htmlContent: campaign.contentHtml,
            contentPlain: campaign.contentPlain || undefined,
            recipientEmail: freshSub.email,
            unsubscribeWebUrl,
            unsubscribeApiUrl,
            archiveUrl,
          });

          // Use recipient-specific idempotency key for provider-level duplicate dispatch protection
          const idempotencyKey = `campaign:${campaign.id}:recipient:${item.recipientId}`;

          // Ultra-tight pre-send fencing, atomic cancellation coordination & GDPR shield:
          // Atomically acquire a durable dispatch permit under a FOR SHARE row lock on the campaign.
          // This serializes directly with cancellation transactions (which hold FOR UPDATE),
          // guaranteeing that if cancellation is in progress, dispatch halts BEFORE contacting the provider!
          permitToken = `permit:${claimToken}:${randomUUID()}`;

          const permit = await db.transaction(async (tx) => {
            const [campaignLock] = await tx.execute<typeof campaigns.$inferSelect>(sql`
              SELECT status FROM campaigns WHERE id = ${campaign.id} FOR SHARE;
            `);

            if (campaignLock?.status !== "sending") {
              return {
                granted: false,
                permitToken: null,
                reason: `Campaign status changed to '${campaignLock?.status || "missing"}' (not 'sending')`,
                stopLoop: true,
              };
            }

            const [stillClaimed] = await tx
              .select({ id: campaignRecipients.id, claimToken: campaignRecipients.claimToken })
              .from(campaignRecipients)
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  eq(campaignRecipients.claimToken, claimToken)
                )
              );

            if (!stillClaimed || stillClaimed.claimToken !== claimToken) {
              return {
                granted: false,
                permitToken: null,
                reason: "Recipient claim was cancelled, aborted, or revoked concurrently",
                stopLoop: false,
              };
            }

            const [stillActiveSub] = await tx
              .select({ id: subscribers.id })
              .from(subscribers)
              .where(
                and(
                  eq(subscribers.id, freshSub.id),
                  eq(subscribers.status, "active")
                )
              );

            if (!stillActiveSub) {
              return {
                granted: false,
                permitToken: null,
                reason: `Subscriber ${freshSub.id} was deleted or deactivated concurrently`,
                stopLoop: false,
              };
            }

            const [preSendSuppressed] = await tx
              .select({ id: suppressions.id })
              .from(suppressions)
              .where(eq(suppressions.email, normalizedEmail));

            if (preSendSuppressed) {
              return {
                granted: false,
                permitToken: null,
                reason: `Recipient ${item.recipientId} (${normalizedEmail}) was added to suppressions concurrently`,
                stopLoop: false,
              };
            }

            // Durably record the dispatch permit on the recipient row in PostgreSQL
            const [grantedRow] = await tx
              .update(campaignRecipients)
              .set({
                claimToken: permitToken,
                errorMessage: "in_flight_permitted",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  eq(campaignRecipients.claimToken, claimToken)
                )
              )
              .returning({ id: campaignRecipients.id });

            if (!grantedRow) {
              return {
                granted: false,
                permitToken: null,
                reason: "Failed to persist durable dispatch permit",
                stopLoop: false,
              };
            }

            return { granted: true, permitToken, reason: null, stopLoop: false };
          });

          if (!permit.granted || !permit.permitToken) {
            console.warn(`[Dispatch Permit Refused] ${permit.reason}. Aborting external dispatch.`);
            failCount++;
            if (permit.stopLoop) {
              break;
            }
            continue;
          }

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
            // Check if campaign was cancelled while email was in flight to provider
            const [currentCampState] = await db
              .select({ status: campaigns.status })
              .from(campaigns)
              .where(eq(campaigns.id, campaign.id));

            const isCancelled = currentCampState?.status === "cancelled";

            // Conditional state transition: set status = 'sent' matching this worker's permitToken
            // Atomically update recipient and recalculate cancelled campaign counters if cancelled
            const updateRes = await db.transaction(async (tx) => {
              const res = await tx
                .update(campaignRecipients)
                .set({
                  status: "sent",
                  providerMessageId: sendResult.messageId,
                  sentAt: new Date(),
                  updatedAt: new Date(),
                  errorMessage: isCancelled
                    ? "Dispatched under permit prior to cancellation confirmation"
                    : null,
                })
                .where(
                  and(
                    eq(campaignRecipients.id, item.recipientId),
                    eq(campaignRecipients.status, "processing"),
                    sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permit.permitToken})`
                  )
                )
                .returning({ id: campaignRecipients.id });

              if (res.length === 0) {
                console.warn(
                  `[Worker Fencing] Recipient ${item.recipientId} claim token mismatch, cancelled, or lease expired. Discarding normal update.`
                );
                // In-flight cancellation reconciliation: If provider accepted the email while cancellation
                // was committing, record providerMessageId so external delivery proof is preserved for webhook reconciliation
                await tx
                  .update(campaignRecipients)
                  .set({
                    providerMessageId: sendResult.messageId,
                    sentAt: new Date(),
                    errorMessage: "Dispatched to provider prior to cancellation confirmation",
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(campaignRecipients.id, item.recipientId),
                      sql`${campaignRecipients.status} IN ('processing', 'failed')`
                    )
                  );
              }

              if (isCancelled) {
                // Synchronize parent campaign counters in the same transaction
                const [counts] = await tx
                  .select({
                    total: sql<number>`count(*)::int`,
                    sent: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('sent', 'delivered'))::int`,
                    failed: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('failed', 'bounced'))::int`,
                  })
                  .from(campaignRecipients)
                  .where(eq(campaignRecipients.campaignId, campaign.id));

                await tx
                  .update(campaigns)
                  .set({
                    totalRecipients: counts?.total ?? campaign.totalRecipients,
                    successfulSends: counts?.sent ?? campaign.successfulSends,
                    failedSends: counts?.failed ?? campaign.failedSends,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(campaigns.id, campaign.id),
                      eq(campaigns.status, "cancelled")
                    )
                  );
              }

              return res;
            });

            if (updateRes.length > 0) {
              successCount++;
            }
          } else {
            const currentAttempts = (claimed.attempt_count ?? item.attemptCount ?? 0) + 1;
            const errorMsg = sendResult.error || "Email provider dispatch failed";

            const isPermanent =
              errorMsg.toLowerCase().includes("suppress") ||
              errorMsg.toLowerCase().includes("blacklisted") ||
              errorMsg.toLowerCase().includes("invalid email") ||
              errorMsg.toLowerCase().includes("does not exist");

            if (sendResult.isAmbiguous) {
              if (currentAttempts >= MAX_RECIPIENT_ATTEMPTS) {
                console.error(
                  `[Worker Ambiguous Threshold Exceeded] Recipient ${item.recipientId} reached max attempts (${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}) with ambiguous outcome: '${errorMsg}'. Halting automated resend; setting status to 'needs_review' for webhook/manual reconciliation.`
                );
                await db
                  .update(campaignRecipients)
                  .set({
                    status: "needs_review",
                    attemptCount: currentAttempts,
                    lastAttemptAt: new Date(),
                    nextAttemptAt: null, // Clear nextAttemptAt to halt automated retries
                    errorMessage: `Ambiguous dispatch outcome exceeded max attempts (${MAX_RECIPIENT_ATTEMPTS}). Held in needs_review awaiting webhook reconciliation: ${errorMsg}`,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(campaignRecipients.id, item.recipientId),
                      eq(campaignRecipients.status, "processing"),
                      sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permitToken})`
                    )
                  );
                failCount++;
              } else {
                // Hold in 'unknown_outcome' for webhook reconciliation window (2 mins) before retrying
                const reconciliationDelayMinutes = 2;
                const nextAttemptAt = new Date(Date.now() + reconciliationDelayMinutes * 60 * 1000);

                console.warn(
                  `[Worker Ambiguous Outcome] Potential in-flight dispatch for recipient ${item.recipientId} (Attempt ${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}): '${errorMsg}'. Moving to 'unknown_outcome' until ${nextAttemptAt.toISOString()} for webhook reconciliation.`
                );

                await db
                  .update(campaignRecipients)
                  .set({
                    status: "unknown_outcome",
                    attemptCount: currentAttempts,
                    lastAttemptAt: new Date(),
                    nextAttemptAt,
                    errorMessage: `Ambiguous outcome (Attempt ${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}): ${errorMsg}`,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(campaignRecipients.id, item.recipientId),
                      eq(campaignRecipients.status, "processing"),
                      sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permitToken})`
                    )
                  );
              }
            } else if (!isPermanent && currentAttempts < MAX_RECIPIENT_ATTEMPTS) {
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
                .where(
                  and(
                    eq(campaignRecipients.id, item.recipientId),
                    eq(campaignRecipients.status, "processing"),
                    sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permitToken})`
                  )
                );
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
                .where(
                  and(
                    eq(campaignRecipients.id, item.recipientId),
                    eq(campaignRecipients.status, "processing"),
                    sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permitToken})`
                  )
                );
            }
          }
        } catch (sendErr: any) {
          const currentAttempts = (claimed.attempt_count ?? item.attemptCount ?? 0) + 1;
          const errorMsg = sendErr.message || "Unexpected exception during dispatch";

          if (currentAttempts >= MAX_RECIPIENT_ATTEMPTS) {
            console.error(
              `[Worker Exception Limit Exceeded] Recipient ${item.recipientId} reached max attempts (${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}) with exception: '${errorMsg}'. Halting automated resend; setting status to 'needs_review'.`
            );
            await db
              .update(campaignRecipients)
              .set({
                status: "needs_review",
                attemptCount: currentAttempts,
                lastAttemptAt: new Date(),
                nextAttemptAt: null,
                errorMessage: `Exception exceeded max attempts (${MAX_RECIPIENT_ATTEMPTS}). Held in needs_review awaiting reconciliation: ${errorMsg}`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permitToken ?? claimToken})`
                )
              );
            failCount++;
          } else {
            const reconciliationDelayMinutes = 2;
            const nextAttemptAt = new Date(Date.now() + reconciliationDelayMinutes * 60 * 1000);

            console.warn(
              `[Worker Exception] Ambiguous exception for recipient ${item.recipientId} (Attempt ${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}): '${errorMsg}'. Moving to 'unknown_outcome' for webhook reconciliation.`
            );

            await db
              .update(campaignRecipients)
              .set({
                status: "unknown_outcome",
                attemptCount: currentAttempts,
                lastAttemptAt: new Date(),
                nextAttemptAt,
                errorMessage: `Exception (Attempt ${currentAttempts}/${MAX_RECIPIENT_ATTEMPTS}): ${errorMsg}`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(campaignRecipients.id, item.recipientId),
                  eq(campaignRecipients.status, "processing"),
                  sql`${campaignRecipients.claimToken} IN (${claimToken}, ${permitToken ?? claimToken})`
                )
              );
          }
        }
      }

      // Refresh lease after completing each batch chunk
      if (jobId && leaseToken) {
        const renewed = await renewJobLease(jobId, leaseToken);
        if (!renewed) {
          leaseLost = true;
          break;
        }
      }
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }

  if (leaseLost) {
    console.warn(`[Worker Notice] Exiting campaign dispatch early for '${campaign.title}' because queue lease was lost.`);
    return;
  }

  // 5. Pre-finalization check: ensure campaign wasn't cancelled mid-dispatch
  const [campaignPostCheck] = await db
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));

  if (campaignPostCheck?.status === "cancelled") {
    console.log(`[Worker] Campaign ${campaignId} is cancelled; skipping retry rescheduling and finalization.`);
    await db
      .update(campaignRecipients)
      .set({
        status: "failed",
        errorMessage: "Cancelled by campaign cancellation",
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          sql`(${campaignRecipients.claimToken} IS NULL OR ${campaignRecipients.claimToken} NOT LIKE 'permit:%')`,
          sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
        )
      );
    return;
  }

  // 6. Check if any recipients are still pending or waiting for next retry attempt
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

    // Atomic Outbox & Queue Coordination:
    // Acquire a FOR UPDATE row lock on the campaign row inside a transaction to serialize with cancellation.
    // If an admin cancels the campaign, cancel/route.ts holds FOR UPDATE, updates status to 'cancelled', and purges automation_jobs.
    // By locking FOR UPDATE here and verifying status === 'sending' before calling enqueueJob(..., tx),
    // no zombie retry job can ever be inserted after a cancellation purge.
    const scheduled = await db.transaction(async (tx) => {
      const [lockedCampaign] = await tx.execute<typeof campaigns.$inferSelect>(sql`
        SELECT * FROM campaigns
        WHERE id = ${campaignId}
        FOR UPDATE;
      `);

      if (!lockedCampaign || lockedCampaign.status !== "sending") {
        console.warn(
          `[Worker Retry Guard] Campaign ${campaignId} is in status '${lockedCampaign?.status || "missing"}' (not 'sending'). Skipping retry queue scheduling.`
        );
        return false;
      }

      await tx
        .update(campaigns)
        .set({ updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));

      await enqueueJob(
        "process_campaign",
        { campaignId: campaign.id },
        {
          scheduledFor: earliestWakeup,
          idempotencyKey: `campaign:${campaign.id}:retry:${earliestWakeup.getTime()}`,
        },
        tx
      );

      return true;
    });

    if (scheduled) {
      console.log(
        `[Worker] Campaign '${campaign.title}' still has ${remainingActive.length} active/retryable recipients. Re-scheduled queue job for ${earliestWakeup.toISOString()}.`
      );
    }
    return;
  }

  // 6. Only when ALL recipients have reached a terminal state (sent, delivered, failed, bounced):
  const allRecipients = await db
    .select({ status: campaignRecipients.status })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id));

  const total = allRecipients.length;
  const sent = allRecipients.filter((r) => r.status === "sent" || r.status === "delivered").length;
  const failed = allRecipients.filter((r) => r.status === "failed" || r.status === "bounced" || r.status === "needs_review").length;

  let finalCampaignStatus: "sent" | "partially_failed" | "failed" = "sent";
  if (failed > 0 && sent > 0) {
    finalCampaignStatus = "partially_failed";
  } else if (failed > 0 && sent === 0) {
    finalCampaignStatus = "failed";
  }

  // ATOMIC FINALIZATION FENCING:
  // We strictly require campaigns.status = 'sending'.
  // If a concurrent webhook has already reconciled the campaign into a terminal state ('partially_failed', 'failed', 'sent')
  // or if an admin cancelled it, this conditional update returns 0 rows.
  // The worker MUST NOT overwrite the webhook's fresh, accurate metrics with stale in-memory counters!
  const [updatedCampaign] = await db
    .update(campaigns)
    .set({
      status: finalCampaignStatus,
      sentAt: new Date(),
      totalRecipients: total,
      successfulSends: sent,
      failedSends: failed,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(campaigns.id, campaignId),
        eq(campaigns.status, "sending")
      )
    )
    .returning({
      id: campaigns.id,
      status: campaigns.status,
    });

  if (!updatedCampaign) {
    console.log(
      `[Worker Finalization Notice] Campaign '${campaign.title}' was already transitioned away from 'sending' (e.g. by concurrent webhook reconciliation or admin cancellation). Skipping stale finalization write.`
    );
    return;
  }

  console.log(
    `[Worker] Campaign '${campaign.title}' dispatch finalized with status '${finalCampaignStatus}'. Sent: ${sent}, Failed: ${failed}, Total: ${total}.`
  );
}
