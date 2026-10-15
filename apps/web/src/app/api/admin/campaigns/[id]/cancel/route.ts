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
    // 1. Transactionally lock and verify campaign status
    // 2. Transition campaign status from 'scheduled' or 'sending' to 'cancelled'
    // 3. Immediately abort all in-flight, queued, and unknown_outcome recipients (claimToken: null, status: failed)
    // 4. Purge/delete queued process_campaign automation jobs from the queue table
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId));

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

      // 1. Atomically update campaign status to 'cancelled'
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

      // 2. Abort all remaining recipients in non-terminal states
      const recipientAbortResult = await tx
        .update(campaignRecipients)
        .set({
          status: "failed",
          errorMessage: "Cancelled by admin request",
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaignRecipients.campaignId, campaignId),
            sql`${campaignRecipients.status} IN ('queued', 'processing', 'unknown_outcome')`
          )
        );

      // 3. Purge/cancel any queued process_campaign jobs in the queue
      await tx.execute(sql`
        DELETE FROM automation_jobs
        WHERE job_name = 'process_campaign'
          AND (payload->>'campaignId' = ${campaignId});
      `);

      return {
        success: true,
        campaign: cancelledCampaign,
        abortedRecipientsCount: (recipientAbortResult as any)?.rowCount || 0,
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
    if (result.alreadyCancelled) {
      return NextResponse.json({
        success: true,
        message: "Campaign was already cancelled.",
        campaign: result.campaign,
      });
    }

    return NextResponse.json({
      success: true,
      message: "Campaign cancelled successfully. In-flight and pending recipients have been aborted.",
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
