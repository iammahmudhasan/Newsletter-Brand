import { NextRequest, NextResponse } from "next/server";
import { db, campaigns } from "@ai-signal/db";
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

    // 1. Create campaign in DB
    const [inserted] = await db
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

    let jobId: string | null = null;

    // 2. If immediate dispatch requested, atomically enqueue with idempotency key
    if (isImmediateSend) {
      jobId = await enqueueJob(
        "process_campaign",
        { campaignId: inserted.id },
        { idempotencyKey: `campaign:${inserted.id}:dispatch` }
      );
    }

    return NextResponse.json(
      {
        success: true,
        campaignId: inserted.id,
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
