import { NextResponse } from "next/server";
import { db, subscribers, suppressions, automationJobs, emailEvents, sql } from "@ai-signal/db";

export async function GET() {
  const startTime = Date.now();
  const alerts: string[] = [];

  try {
    // 1. Check DB connectivity
    await db.execute(sql`SELECT 1`);

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
      })
      .from(emailEvents);

    const totalSends = Number(telemetry?.delivered || 0) + Number(telemetry?.bounces || 0);
    const bounceRate = totalSends > 0 ? (Number(telemetry?.bounces || 0) / totalSends) * 100 : 0;
    const complaintRate = totalSends > 0 ? (Number(telemetry?.complaints || 0) / totalSends) * 100 : 0;

    // Evaluate deliverability health thresholds
    if (bounceRate > 0.3) {
      alerts.push(`High bounce rate warning: ${bounceRate.toFixed(2)}% (Target: <0.2%)`);
    }
    if (complaintRate > 0.05) {
      alerts.push(`Critical spam complaint warning: ${complaintRate.toFixed(3)}% (Google limit: <0.1%)`);
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
        deliveredCount: Number(telemetry?.delivered || 0),
        bounceRate: `${bounceRate.toFixed(2)}%`,
        complaintRate: `${complaintRate.toFixed(3)}%`,
      },
      alerts,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        status: "unhealthy",
        error: err.message,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
