import { db, campaigns, automationJobs, sql, eq } from "@ai-signal/db";
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
    const stuckCampaigns = await db.execute<typeof campaigns.$inferSelect>(
      sql`
        SELECT c.* FROM campaigns c
        WHERE c.status = 'sending'
          AND c.updated_at < NOW() - INTERVAL '15 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM automation_jobs j
            WHERE j.job_name = 'process_campaign'
              AND (j.payload->>'campaignId' = c.id::text)
              AND j.status = 'processing'
              AND j.locked_at > NOW() - INTERVAL '10 minutes'
          )
        LIMIT 5;
      `
    );

    const stuckList = (stuckCampaigns as any) || [];
    for (const stuck of stuckList) {
      console.warn(`[Scheduler Recovery] Re-enqueuing stuck campaign '${stuck.title}' (${stuck.id}) without active worker lease.`);
      await enqueueJob(
        "process_campaign",
        { campaignId: stuck.id },
        { idempotencyKey: `campaign:${stuck.id}:recovery:${Math.floor(Date.now() / (10 * 60 * 1000))}` }
      );
    }

    return claimedCount;
  } catch (err: any) {
    console.error("[Scheduler Error]:", err.message);
    return claimedCount;
  }
}
