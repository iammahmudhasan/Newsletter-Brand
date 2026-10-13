import { db, campaigns, sql, eq } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";

/**
 * Atomically claims and schedules due campaigns using FOR UPDATE SKIP LOCKED
 * to guarantee zero duplicate job dispatches across multiple worker instances.
 */
export async function runCampaignScheduler(): Promise<number> {
  let claimedCount = 0;

  try {
    // 1. Process due scheduled campaigns
    while (true) {
      // Atomically select and transition one due campaign from 'scheduled' -> 'sending'
      const claimedRows = await db.execute<typeof campaigns.$inferSelect>(
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

      const claimedCampaign = (claimedRows as any)?.[0];
      if (!claimedCampaign) {
        break; // No more due campaigns to process
      }

      console.log(
        `[Scheduler] Atomically claimed campaign '${claimedCampaign.title}' (ID: ${claimedCampaign.id})`
      );

      try {
        // Enqueue job with unique idempotency key
        await enqueueJob(
          "process_campaign",
          {
            campaignId: claimedCampaign.id,
          },
          {
            idempotencyKey: `campaign:${claimedCampaign.id}:dispatch`,
          }
        );
        claimedCount++;
      } catch (enqueueErr: any) {
        console.error(
          `[Scheduler Error] Failed to enqueue job for campaign ${claimedCampaign.id}. Rolling back status to 'scheduled':`,
          enqueueErr.message
        );
        // Rollback campaign status to scheduled so it isn't orphaned
        await db
          .update(campaigns)
          .set({ status: "scheduled", updatedAt: new Date() })
          .where(eq(campaigns.id, claimedCampaign.id));
      }
    }

    // 2. Recovery: Check for any campaigns stuck in 'sending' for > 15 minutes without progress
    const stuckCampaigns = await db.execute<typeof campaigns.$inferSelect>(
      sql`
        SELECT * FROM campaigns
        WHERE status = 'sending'
          AND updated_at < NOW() - INTERVAL '15 minutes'
        LIMIT 5;
      `
    );

    const stuckList = (stuckCampaigns as any) || [];
    for (const stuck of stuckList) {
      console.warn(`[Scheduler Recovery] Re-enqueuing stuck campaign '${stuck.title}' (${stuck.id})`);
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
