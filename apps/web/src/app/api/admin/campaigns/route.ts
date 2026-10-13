import { NextRequest, NextResponse } from "next/server";
import { db, campaigns, eq } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { sanitizeNewsletterHtml } from "@ai-signal/email";
import { isAuthorizedAdmin } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { error: "Unauthorized: Valid admin session required" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { title, subject, previewText, contentHtml, contentPlain, scheduledAt, sendNow } = body;

    if (!title || !subject || !contentHtml) {
      return NextResponse.json(
        { error: "Title, Subject, and Content HTML are required" },
        { status: 400 }
      );
    }

    // Server-side allowlist HTML sanitization to prevent persistent stored XSS
    const sanitizedHtml = sanitizeNewsletterHtml(contentHtml);

    const isImmediateSend = sendNow === true || !scheduledAt || new Date(scheduledAt).getTime() <= Date.now();
    const scheduleDate = scheduledAt ? new Date(scheduledAt) : new Date();

    // Transactional Outbox: Atomically persist campaign and outbox job in a single database transaction
    const { campaignId, jobId } = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(campaigns)
        .values({
          title: title.trim(),
          subject: subject.trim(),
          previewText: previewText?.trim() || "",
          contentHtml: sanitizedHtml,
          contentPlain: contentPlain?.trim() || "",
          status: isImmediateSend ? "sending" : "scheduled",
          scheduledAt: scheduleDate,
        })
        .returning({ id: campaigns.id });

      let enqueuedJobId: string | null = null;
      if (isImmediateSend) {
        enqueuedJobId = await enqueueJob(
          "process_campaign",
          { campaignId: inserted.id },
          { idempotencyKey: `campaign:${inserted.id}:dispatch` },
          tx
        );
      }

      return { campaignId: inserted.id, jobId: enqueuedJobId };
    });

    return NextResponse.json(
      {
        success: true,
        campaignId,
        jobId,
        status: isImmediateSend ? "sending" : "scheduled",
        message: isImmediateSend
          ? "Campaign created and enqueued for immediate worker dispatch!"
          : `Campaign scheduled for dispatch at ${scheduleDate.toISOString()}`,
      },
      { status: 201 }
    );
  } catch (err: any) {
    console.error("[Admin Campaign Error]:", err.message);
    return NextResponse.json(
      { error: err?.message || "Failed to create campaign" },
      { status: 500 }
    );
  }
}
