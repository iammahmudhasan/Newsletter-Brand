import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, automationJobs, emailEvents, campaignRecipients, sql } from "@ai-signal/db";
import { isAuthorizedAdmin } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const startTime = Date.now();

  try {
    // 1. Check basic DB connectivity
    await db.execute(sql`SELECT 1`);

    const isAdmin = isAuthorizedAdmin(req);

    // Public health response: minimal status, no internal telemetry leaks
    if (!isAdmin) {
      return NextResponse.json(
        {
          status: "healthy",
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    // Authenticated admin response: detailed operational metrics
    const alerts: string[] = [];

    // 2. Fetch subscriber health counts
    const [subStats] = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where status = 'active')`,
        pending: sql<number>`count(*) filter (where status = 'pending_confirmation')`,
        unsubscribed: sql<number>`count(*) filter (where status = 'unsubscribed')`,
        bounced: sql<number>`count(*) filter (where status = 'bounced')`,
      })
      .from(subscribers);

    // 3. Fetch queue status
    const [queueStats] = await db
      .select({
        pending: sql<number>`count(*) filter (where status = 'pending')`,
        processing: sql<number>`count(*) filter (where status = 'processing')`,
        failed: sql<number>`count(*) filter (where status = 'failed')`,
      })
      .from(automationJobs);

    // 4. Fetch delivery event telemetry and attempted recipient counts
    const [recipientStats] = await db
      .select({
        totalRecipients: sql<number>`count(*)`,
        totalAttempted: sql<number>`count(*) filter (where status in ('sent', 'delivered', 'bounced', 'failed', 'needs_review', 'unknown_outcome'))`,
        delivered: sql<number>`count(*) filter (where status = 'delivered')`,
        sent: sql<number>`count(*) filter (where status = 'sent')`,
        bounced: sql<number>`count(*) filter (where status = 'bounced')`,
        failed: sql<number>`count(*) filter (where status = 'failed')`,
        unknownOutcome: sql<number>`count(*) filter (where status = 'unknown_outcome')`,
      })
      .from(campaignRecipients);

    const [eventTelemetry] = await db
      .select({
        uniqueComplaints: sql<number>`count(distinct coalesce(recipient_id::text, provider_message_id)) filter (where event_type = 'complaint')`,
        uniqueDelivered: sql<number>`count(distinct coalesce(recipient_id::text, provider_message_id)) filter (where event_type = 'delivered')`,
      })
      .from(emailEvents);

    const totalAttemptedSends = Number(recipientStats?.totalAttempted || 0);
    const deliveredCount = Number(recipientStats?.delivered || 0);
    const sentCount = Number(recipientStats?.sent || 0);
    const bounceCount = Number(recipientStats?.bounced || 0);
    const complaintCount = Number(eventTelemetry?.uniqueComplaints || 0);
    const deliveredTelemetryCount = Number(eventTelemetry?.uniqueDelivered || 0);

    // Primary denominator for bounce rate: total attempted recipient dispatches (including unknown_outcome).
    let bounceDenominator = totalAttemptedSends;
    if (bounceDenominator === 0) {
      const [fallbackEvents] = await db
        .select({
          distinctMessages: sql<number>`count(distinct coalesce(provider_message_id, id::text))`,
        })
        .from(emailEvents);
      bounceDenominator = Number(fallbackEvents?.distinctMessages || 0);
    }

    // Stable denominator for spam complaints:
    // Mailbox providers (Google/Yahoo) compute complaint rate strictly against successfully delivered messages.
    // CRITICAL: We prioritize the immutable audit events (uniqueDelivered from email_events) over
    // current recipient status, because when a complaint arrives, the recipient's status changes to 'failed',
    // which would otherwise shrink deliveredCount and artificially inflate the complaint ratio!
    let complaintDenominator = deliveredTelemetryCount > 0 ? deliveredTelemetryCount : deliveredCount;
    if (complaintDenominator === 0) {
      complaintDenominator = sentCount > 0 ? sentCount : totalAttemptedSends;
    }
    if (complaintDenominator === 0) {
      complaintDenominator = bounceDenominator;
    }

    const bounceRatio = bounceDenominator > 0 ? bounceCount / bounceDenominator : 0;
    const complaintRatio = complaintDenominator > 0 ? complaintCount / complaintDenominator : 0;

    // Evaluate deliverability health thresholds:
    // Industry target for bounces: < 0.2% (decimal ratio: 0.002)
    // Google / Yahoo mailbox complaint limit: < 0.1% (decimal ratio: 0.001)
    if (bounceRatio > 0.002) {
      alerts.push(`High bounce rate warning: ${(bounceRatio * 100).toFixed(2)}% (Target: <0.20%)`);
    }
    if (complaintRatio > 0.001) {
      alerts.push(`Critical spam complaint warning: ${(complaintRatio * 100).toFixed(3)}% (Google limit: <0.10%)`);
    }
    if (Number(queueStats?.failed || 0) > 5) {
      alerts.push(`Queue warning: ${queueStats?.failed} failed jobs in queue`);
    }

    return NextResponse.json({
      status: alerts.length > 0 ? "warning" : "healthy",
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      subscribers: {
        total: Number(subStats?.total || 0),
        active: Number(subStats?.active || 0),
        pending: Number(subStats?.pending || 0),
        unsubscribed: Number(subStats?.unsubscribed || 0),
      },
      queue: {
        pendingJobs: Number(queueStats?.pending || 0),
        processingJobs: Number(queueStats?.processing || 0),
        failedJobs: Number(queueStats?.failed || 0),
      },
      deliverability: {
        attemptedSends: totalAttemptedSends,
        deliveredCount,
        bounceCount,
        complaintCount,
        bounceRate: `${(bounceRatio * 100).toFixed(2)}%`,
        complaintRate: `${(complaintRatio * 100).toFixed(3)}%`,
      },
      alerts,
    });
  } catch (err: any) {
    const isAdmin = isAuthorizedAdmin(req);
    return NextResponse.json(
      {
        status: "unhealthy",
        ...(isAdmin ? { error: err.message } : {}),
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
