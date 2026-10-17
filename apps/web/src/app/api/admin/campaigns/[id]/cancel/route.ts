import { NextRequest, NextResponse } from "next/server";
import { db, campaigns, campaignRecipients, eq, and, sql } from "@ai-signal/db";
import { isAuthorizedAdmin } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { error: "Unauthorized: Valid admin session required" },
        { status: 401 }
      );
    }

    const { id: campaignId } = await params;
    if (!campaignId) {
      return NextResponse.json(
        { error: "Missing campaignId parameter" },
        { status: 400 }
      );
    }

    // Atomic Cancellation Coordination Protocol:
    // 1. Transactionally lock campaign row with FOR UPDATE to prevent concurrency races
    // 2. Transition campaign status from 'scheduled' or 'sending' to 'cancelled'
    // 3. Verify cancelledCampaign row was returned before touching recipients or queue jobs
    // 4. Immediately abort all in-flight, queued, and unknown_outcome recipients (claimToken: null, status: failed)
    // 5. Purge/delete queued process_campaign automation jobs from the queue table
    const result = await db.transaction(async (tx) => {
      // 1. Transaction-level row lock
      const [existing] = await tx.execute<typeof campaigns.$inferSelect>(sql`
        SELECT * FROM campaigns
        WHERE id = ${campaignId}
        FOR UPDATE;
      `);

      if (!existing) {
        return { notFound: true };
      }

      if (existing.status === "cancelled") {
        return { alreadyCancelled: true, campaign: existing };
      }

      if (["sent", "partially_failed", "failed"].includes(existing.status)) {
        return {
          alreadyTerminal: true,
          status: existing.status,
          message: `Campaign has already reached terminal status '${existing.status}' and cannot be cancelled.`,
        };
      }

      // 2. Atomically update campaign status to 'cancelled' with strict conditional check
      const [cancelledCampaign] = await tx
        .update(campaigns)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaigns.id, campaignId),
            sql`${campaigns.status} IN ('scheduled', 'sending')`
          )
        )
        .returning();

      // CRITICAL RACE GUARD: If the conditional update affected 0 rows, a concurrent process
      // (worker finalization, webhook, or admin) altered the campaign status.
      // We MUST abort immediately WITHOUT modifying recipients or purging queue jobs!
      if (!cancelledCampaign) {
        const [fresh] = await tx
          .select()
          .from(campaigns)
          .where(eq(campaigns.id, campaignId));

        if (!fresh) {
          return { notFound: true };
        }
        if (fresh.status === "cancelled") {
          return { alreadyCancelled: true, campaign: fresh };
        }
        return {
          concurrentConflict: true,
          status: fresh.status,
          message: `Campaign was concurrently transitioned to '${fresh.status}' and could not be cancelled.`,
        };
      }

      // 3. ONLY after successful campaign transition to 'cancelled', partition non-terminal recipients into:
      // (a) in-flight permitted: recipients that have already been granted a durable dispatch permit ('permit:%')
      //     in either 'processing' or 'unknown_outcome' status (preserving dispatch permit state)
      // (b) truly pending / abortable: queued, unknown_outcome, or processing WITHOUT an active dispatch permit
      const inFlightRecipients = await tx
        .select({ id: campaignRecipients.id, status: campaignRecipients.status })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.campaignId, campaignId),
            sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
            sql`${campaignRecipients.claimToken} LIKE 'permit:%'`
          )
        );

      const inFlightCount = inFlightRecipients.length;

      // Abort only the truly pending recipients (no permit granted):
      const abortedRecipients = await tx
        .update(campaignRecipients)
        .set({
          status: "failed",
          errorMessage: "Cancelled by admin request before dispatch permit",
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaignRecipients.campaignId, campaignId),
            sql`(${campaignRecipients.claimToken} IS NULL OR ${campaignRecipients.claimToken} NOT LIKE 'permit:%')`,
            sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
          )
        )
        .returning({ id: campaignRecipients.id });

      const abortedCount = abortedRecipients.length;

      // For in-flight permitted recipients, mark an audit note indicating permit was granted prior to cancellation,
      // but strictly PRESERVE their status ('processing' / 'unknown_outcome') and permit claimToken so the worker or webhook can complete delivery reporting.
      if (inFlightCount > 0) {
        await tx
          .update(campaignRecipients)
          .set({
            errorMessage: "In-flight: dispatch was permitted prior to campaign cancellation",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(campaignRecipients.campaignId, campaignId),
              sql`${campaignRecipients.status} IN ('processing', 'unknown_outcome')`,
              sql`${campaignRecipients.claimToken} LIKE 'permit:%'`
            )
          );
      }

      // 4. Purge/cancel any queued process_campaign jobs in the queue
      await tx.execute(sql`
        DELETE FROM automation_jobs
        WHERE job_name = 'process_campaign'
          AND (payload->>'campaignId' = ${campaignId});
      `);

      // 5. Atomically synchronize parent campaign summary counters to reflect newly aborted recipients
      const [counts] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          sent: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('sent', 'delivered'))::int`,
          failed: sql<number>`count(*) filter (where ${campaignRecipients.status} in ('failed', 'bounced'))::int`,
        })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaignId));

      const [updatedCampaignWithCounts] = await tx
        .update(campaigns)
        .set({
          totalRecipients: counts?.total ?? cancelledCampaign.totalRecipients,
          successfulSends: counts?.sent ?? cancelledCampaign.successfulSends,
          failedSends: counts?.failed ?? cancelledCampaign.failedSends,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId))
        .returning();

      return {
        success: true,
        campaign: updatedCampaignWithCounts || cancelledCampaign,
        abortedRecipientsCount: abortedCount,
        inFlightRecipientsCount: inFlightCount,
      };
    });

    if (result.notFound) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    if (result.alreadyTerminal) {
      return NextResponse.json(
        { error: result.message, status: result.status },
        { status: 400 }
      );
    }
    if (result.concurrentConflict) {
      return NextResponse.json(
        { error: result.message, status: result.status },
        { status: 409 }
      );
    }
    if (result.alreadyCancelled) {
      return NextResponse.json({
        success: true,
        message: "Campaign was already cancelled.",
        campaign: result.campaign,
      });
    }

    const statusMessage =
      result.inFlightRecipientsCount && result.inFlightRecipientsCount > 0
        ? `Campaign cancelled successfully. ${result.abortedRecipientsCount} pending recipients aborted; ${result.inFlightRecipientsCount} in-flight recipients permitted prior to cancellation.`
        : `Campaign cancelled successfully. ${result.abortedRecipientsCount} pending recipients aborted.`;

    return NextResponse.json({
      success: true,
      message: statusMessage,
      abortedRecipientsCount: result.abortedRecipientsCount,
      inFlightRecipientsCount: result.inFlightRecipientsCount,
      campaign: result.campaign,
    });
  } catch (err: any) {
    console.error("[Admin Campaign Cancellation Error]:", err.message);
    return NextResponse.json(
      { error: err?.message || "Failed to cancel campaign" },
      { status: 500 }
    );
  }
}
