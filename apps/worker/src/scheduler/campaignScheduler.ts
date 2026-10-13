import { db, campaigns, eq, and, lte, sql } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";

/**
 * Polls for campaigns that have reached their scheduled dispatch timestamp
 */
export async function runCampaignScheduler(): Promise<number> {
  try {
    const readyCampaigns = await db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.status, "scheduled"),
          lte(campaigns.scheduledAt, new Date())
        )
      );

    if (readyCampaigns.length === 0) return 0;

    let enqueued = 0;
    for (const campaign of readyCampaigns) {
      console.log(
        `[Scheduler] Found ready campaign '${campaign.title}' (Scheduled for: ${campaign.scheduledAt})`
      );

      // Enqueue job
      await enqueueJob("process_campaign", {
        campaignId: campaign.id,
      });

      // Update status to prevent duplicate scheduling
      await db
        .update(campaigns)
        .set({ status: "sending" })
        .where(eq(campaigns.id, campaign.id));

      enqueued++;
    }

    return enqueued;
  } catch (err: any) {
    // If DB is offline, log gracefully
    return 0;
  }
}
