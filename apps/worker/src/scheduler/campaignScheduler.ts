import {
  db,
  campaigns,
  automationJobs,
  campaignRecipients,
  emailEvents,
  sql,
  eq,
  and,
  desc,
} from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";

/**
 * Atomically claims and schedules due campaigns using the Transactional Outbox Pattern:
 * The status transition ('scheduled' -> 'sending') and the queue job creation
 * occur within the EXACT same PostgreSQL transaction.
 * If enqueue fails, the entire transaction rolls back, guaranteeing that a campaign
 * is NEVER orphaned in 'sending' status without an active worker job.
 */
export async function runCampaignScheduler(): Promise<number> {
  let claimedCount = 0;

  try {
    // 1. Process due scheduled campaigns using Transactional Outbox pattern
    while (true) {
      const scheduledCampaign = await db.transaction(async (tx) => {
        // Atomically select and lock one due campaign
        const claimedRows = await tx.execute<typeof campaigns.$inferSelect>(
          sql`
            UPDATE campaigns
            SET status = 'sending', updated_at = NOW()
            WHERE id = (
              SELECT id FROM campaigns
              WHERE status = 'scheduled' AND scheduled_at <= NOW()
              ORDER BY scheduled_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            RETURNING *;
          `
        );

        const claimed = (claimedRows as any)?.[0];
        if (!claimed) {
          return null;
        }

        // Transactional Outbox: Insert process_campaign job within the SAME atomic database transaction
        const idempotencyKey = `campaign:${claimed.id}:dispatch`;
        await tx
          .insert(automationJobs)
          .values({
            jobName: "process_campaign",
            payload: { campaignId: claimed.id },
            status: "pending",
            scheduledFor: new Date(),
            maxRetries: 3,
            idempotencyKey,
          })
          .onConflictDoNothing({ target: automationJobs.idempotencyKey });

        return claimed;
      });

      if (!scheduledCampaign) {
        break; // No more due campaigns to process
      }

      console.log(
        `[Scheduler Outbox] Atomically claimed and enqueued campaign '${scheduledCampaign.title}' (ID: ${scheduledCampaign.id})`
      );
      claimedCount++;
    }

    // 2. Recovery: Check for any campaigns stuck in 'sending' for > 15 minutes without progress
    // AND verify that there is no active queue job currently executing this campaign with a valid lease!
    // CRITICAL: We lock the candidate campaign row with FOR UPDATE SKIP LOCKED inside an atomic transaction.
    // The status is re-verified, updated_at is touched, and the recovery job is enqueued inside the SAME transaction.
    // This serializes with cancel/route.ts (which holds FOR UPDATE on campaigns and purges queue jobs),
    // strictly preventing zombie recovery jobs from being inserted after a cancellation.
    while (true) {
      const recoveredCampaign = await db.transaction(async (tx) => {
        const candidateRows = await tx.execute<typeof campaigns.$inferSelect>(
          sql`
            SELECT c.* FROM campaigns c
            WHERE c.status = 'sending'
              AND c.updated_at < NOW() - INTERVAL '15 minutes'
              AND NOT EXISTS (
                SELECT 1 FROM automation_jobs j
                WHERE j.job_name = 'process_campaign'
                  AND (j.payload->>'campaignId' = c.id::text)
                  AND (
                    (j.status = 'processing' AND j.locked_at > NOW() - INTERVAL '10 minutes')
                    OR (j.status = 'pending')
                  )
              )
            ORDER BY c.updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1;
          `
        );

        const stuck = (candidateRows as any)?.[0];
        if (!stuck) {
          return null;
        }

        // Fencing check: verify campaign is STILL in 'sending' status under the row lock
        if (stuck.status !== "sending") {
          return null;
        }

        // Touch updated_at so this campaign is not immediately selected again
        await tx
          .update(campaigns)
          .set({ updatedAt: new Date() })
          .where(eq(campaigns.id, stuck.id));

        const recoveryIdempotencyKey = `campaign:${stuck.id}:recovery:${Math.floor(Date.now() / (10 * 60 * 1000))}`;
        await tx
          .insert(automationJobs)
          .values({
            jobName: "process_campaign",
            payload: { campaignId: stuck.id },
            status: "pending",
            scheduledFor: new Date(),
            maxRetries: 3,
            idempotencyKey: recoveryIdempotencyKey,
          })
          .onConflictDoNothing({ target: automationJobs.idempotencyKey });

        return stuck;
      });

      if (!recoveredCampaign) {
        break; // No more stuck campaigns to recover
      }

      console.warn(
        `[Scheduler Recovery] Atomically re-enqueued stuck campaign '${recoveredCampaign.title}' (${recoveredCampaign.id}) without active worker lease.`
      );
    }

    // 3. Stale In-Flight Permit Reconciliation for Cancelled & Sending Campaigns:
    // Periodically reconciles recipients that were granted a permit
    // but became stranded due to a worker crash or unconfirmed dispatch.
    await reconcileStaleInFlightPermits(5);

    return claimedCount;
  } catch (err: any) {
    console.error("[Scheduler Error]:", err.message);
    return claimedCount;
  }
}

/**
 * Reconciles stranded in-flight permits on campaigns (both cancelled and active sending).
 *
 * SCENARIO (Worker crash during permit-to-send):
 * When a worker acquires a durable permit ('permit:%') to dispatch an email to SES/Resend,
 * if the worker crashes before completing sendEmail() or writing providerMessageId,
 * the recipient row remains stranded in 'processing' or 'unknown_outcome' with a permit claimToken.
 *
 * This reconciler:
 * 1. Finds recipients that have been stuck in 'processing' or 'unknown_outcome'
 *    with a 'permit:%' claimToken for > staleThresholdMinutes (default: 5 minutes).
 * 2. Checks whether a providerMessageId exists or an email_events webhook record arrived:
 *    - If providerMessageId exists: marks 'sent' with audit note.
 *    - If a matching delivery/bounce webhook event arrived: updates to the webhook outcome.
 *    - If completely unresolved (no messageId and no webhook): transitions status to 'needs_review'
 *      with audit errorMessage (preventing duplicate email dispatch to real subscribers!).
 *      Releases claimToken to null.
 * 3. Re-synchronizes the parent campaign's summary counters (totalRecipients, successfulSends, failedSends).
 * 4. Logs a structured alert for operator awareness.
 */
export async function reconcileStaleInFlightPermits(
  staleThresholdMinutes: number = 5,
  campaignStatusFilter?: "cancelled" | "all"
): Promise<number> {
  let reconciledCount = 0;
  let reconciledCampaignsCount = 0;

  try {
    const statusCondition =
      campaignStatusFilter === "cancelled"
        ? eq(campaigns.status, "cancelled")
        : sql`${campaigns.status} IN ('cancelled', 'sending')`;

    // 1. Discover candidate campaigns that contain potentially stale in-flight permits
    const candidateCampaigns = await db
      .selectDistinct({ id: campaigns.id })
      .from(campaigns)
      .innerJoin(campaignRecipients, eq(campaigns.id, campaignRecipients.campaignId))
      .where(
        and(
          statusCondition,
          sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
          sql`${campaignRecipients.claimToken} LIKE 'permit:%'`,
          sql`${campaignRecipients.updatedAt} < NOW() - (${staleThresholdMinutes} || ' minutes')::interval`
        )
      )
      .limit(20);

    for (const candidate of candidateCampaigns) {
      await db.transaction(async (tx) => {
        // 2a. Row-lock parent campaign
        const [camp] = await tx
          .select({ id: campaigns.id, status: campaigns.status })
          .from(campaigns)
          .where(
            and(
              eq(campaigns.id, candidate.id),
              statusCondition
            )
          )
          .for("update", { skipLocked: true });

        if (!camp) {
          // Concurrently locked or status changed
          return;
        }

        // 2b. Re-select and lock ALL eligible stale permitted recipients for this campaign
        // Re-verifying inside the transaction:
        // - status IN ('processing', 'unknown_outcome')
        // - claimToken LIKE 'permit:%'
        // - updatedAt is STILL older than the threshold
        const staleForCamp = await tx
          .select({
            id: campaignRecipients.id,
            status: campaignRecipients.status,
            claimToken: campaignRecipients.claimToken,
            providerMessageId: campaignRecipients.providerMessageId,
            updatedAt: campaignRecipients.updatedAt,
          })
          .from(campaignRecipients)
          .where(
            and(
              eq(campaignRecipients.campaignId, camp.id),
              sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
              sql`${campaignRecipients.claimToken} LIKE 'permit:%'`,
              sql`${campaignRecipients.updatedAt} < NOW() - (${staleThresholdMinutes} || ' minutes')::interval`
            )
          )
          .for("update", { skipLocked: true });

        if (staleForCamp.length === 0) {
          return;
        }

        // 2c. Reconcile each validated stale recipient
        for (const recip of staleForCamp) {
          if (!recip.claimToken || !recip.claimToken.startsWith("permit:")) {
            continue;
          }

          // Case 1: providerMessageId was already recorded on recipient row
          if (recip.providerMessageId) {
            const updateRes = await tx
              .update(campaignRecipients)
              .set({
                status: "sent",
                errorMessage: `Reconciled after worker crash: email was dispatched under permit with providerMessageId ${recip.providerMessageId}`,
                claimToken: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(campaignRecipients.id, recip.id),
                  sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
                  eq(campaignRecipients.claimToken, recip.claimToken)
                )
              )
              .returning({ id: campaignRecipients.id });

            if (updateRes.length > 0) reconciledCount++;
            continue;
          }

          // Case 2: Check if any webhook event arrived for this recipient
          const [webhookEvent] = await tx
            .select({
              providerMessageId: emailEvents.providerMessageId,
              eventType: emailEvents.eventType,
            })
            .from(emailEvents)
            .where(
              and(
                eq(emailEvents.recipientId, recip.id),
                sql`${emailEvents.eventType} IN ('delivered', 'bounce', 'complaint', 'failed', 'suppressed', 'open', 'click')`
              )
            )
            .orderBy(desc(emailEvents.createdAt))
            .limit(1);

          if (webhookEvent) {
            let resolvedStatus: "delivered" | "bounced" | "failed" = "delivered";
            if (webhookEvent.eventType === "bounce") resolvedStatus = "bounced";
            else if (["complaint", "failed", "suppressed"].includes(webhookEvent.eventType)) resolvedStatus = "failed";

            const updateRes = await tx
              .update(campaignRecipients)
              .set({
                status: resolvedStatus,
                providerMessageId: webhookEvent.providerMessageId || undefined,
                errorMessage: `Reconciled after worker crash: matched delivery event '${webhookEvent.eventType}'`,
                claimToken: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(campaignRecipients.id, recip.id),
                  sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
                  eq(campaignRecipients.claimToken, recip.claimToken)
                )
              )
              .returning({ id: campaignRecipients.id });

            if (updateRes.length > 0) reconciledCount++;
            continue;
          }

          // Case 3: Truly unresolved dispatch outcome
          // Transition to 'needs_review' with explicit audit message to PREVENT duplicate send!
          const updateRes = await tx
            .update(campaignRecipients)
            .set({
              status: "needs_review",
              errorMessage:
                camp.status === "cancelled"
                  ? "Reconciled: in-flight permit timed out after campaign cancellation with unconfirmed dispatch outcome (possible worker crash)"
                  : "Reconciled after worker crash: in-flight permit timed out with unconfirmed dispatch outcome. Held in needs_review to prevent duplicate dispatch.",
              claimToken: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(campaignRecipients.id, recip.id),
                sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
                eq(campaignRecipients.claimToken, recip.claimToken)
              )
            )
            .returning({ id: campaignRecipients.id });

          if (updateRes.length > 0) reconciledCount++;
        }

        // 2d. CRITICAL ATOMICITY GUARD:
        // Recalculate parent campaign summary counters in the EXACT SAME transaction!
        const [counts] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            sent: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('sent', 'delivered'))::int`,
            failed: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('failed', 'bounced'))::int`,
          })
          .from(campaignRecipients)
          .where(eq(campaignRecipients.campaignId, camp.id));

        await tx
          .update(campaigns)
          .set({
            totalRecipients: counts?.total ?? 0,
            successfulSends: counts?.sent ?? 0,
            failedSends: counts?.failed ?? 0,
            updatedAt: new Date(),
          })
          .where(eq(campaigns.id, camp.id));

        reconciledCampaignsCount++;
      });
    }

    if (reconciledCount > 0) {
      console.warn(
        `[Reconciler Alert - In-Flight Permit Recovery] Reconciled ${reconciledCount} stranded in-flight permit(s) across ${reconciledCampaignsCount} campaign(s).`
      );
    }

    return reconciledCount;
  } catch (err: any) {
    console.error("[In-Flight Permit Reconciler Error]:", err.message);
    return reconciledCount;
  }
}

/**
 * Reconciles stranded in-flight permits on cancelled campaigns.
 * Provided for backwards compatibility with existing consumers and test suites.
 */
export async function reconcileCancelledCampaignInFlightPermits(
  staleThresholdMinutes: number = 5
): Promise<number> {
  return reconcileStaleInFlightPermits(staleThresholdMinutes, "cancelled");
}
