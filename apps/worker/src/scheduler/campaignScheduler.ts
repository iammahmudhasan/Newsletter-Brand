import { db, campaigns, sql } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";

/**
 * Atomically claims and schedules due campaigns using FOR UPDATE SKIP LOCKED
 * to guarantee zero duplicate job dispatches across multiple worker instances.
 */
export async function runCampaignScheduler(): Promise<number> {
  let claimedCount = 0;

  try {
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
    }

    return claimedCount;
  } catch (err: any) {
    console.error("[Scheduler Error]:", err.message);
    return claimedCount;
  }
}
