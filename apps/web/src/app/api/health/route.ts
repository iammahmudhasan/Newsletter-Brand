import { NextRequest, NextResponse } from "next/server";
import { db, subscribers, automationJobs, emailEvents, sql } from "@ai-signal/db";
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

    // 4. Fetch delivery event telemetry
    const [telemetry] = await db
      .select({
        totalEvents: sql<number>`count(*)`,
        delivered: sql<number>`count(*) filter (where event_type = 'delivered')`,
        bounces: sql<number>`count(*) filter (where event_type = 'bounce')`,
        complaints: sql<number>`count(*) filter (where event_type = 'complaint')`,
        failed: sql<number>`count(*) filter (where event_type = 'failed')`,
      })
      .from(emailEvents);

    const deliveredCount = Number(telemetry?.delivered || 0);
    const bounceCount = Number(telemetry?.bounces || 0);
    const complaintCount = Number(telemetry?.complaints || 0);
    const failedCount = Number(telemetry?.failed || 0);

    // Total delivery outcome events represent the denominator for rates
    const totalOutcomes = deliveredCount + bounceCount + complaintCount + failedCount;
    const bounceRatio = totalOutcomes > 0 ? bounceCount / totalOutcomes : 0;
    const complaintRatio = totalOutcomes > 0 ? complaintCount / totalOutcomes : 0;

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
        deliveredCount,
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
