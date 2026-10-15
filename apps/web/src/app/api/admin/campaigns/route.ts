import { NextRequest, NextResponse } from "next/server";
import { db, campaigns, eq, sql } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { sanitizeNewsletterHtml } from "@ai-signal/email";
import { isAuthorizedAdmin } from "@/lib/auth";

export async function POST(req: NextRequest) {
  let resolvedIdempotencyKey: string | null = null;

  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { error: "Unauthorized: Valid admin session required" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { title, subject, previewText, contentHtml, contentPlain, scheduledAt, sendNow } = body || {};

    // 1. Request-level idempotency protection: Return existing campaign if key matches
    // Properly fall back to body idempotencyKey if header is empty or whitespace-only
    const headerKey = req.headers.get("idempotency-key")?.trim() || "";
    const bodyKey = (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "")?.trim() || "";
    resolvedIdempotencyKey = (headerKey && headerKey.length > 0) ? headerKey : (bodyKey && bodyKey.length > 0) ? bodyKey : null;

    if (resolvedIdempotencyKey) {
      const [existing] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.idempotencyKey, resolvedIdempotencyKey));

      if (existing) {
        return NextResponse.json(
          {
            success: true,
            campaignId: existing.id,
            issueNumber: existing.issueNumber,
            status: existing.status,
            duplicate: true,
            message: "Campaign already created with this idempotency key",
          },
          { status: 200 }
        );
      }
    }

    // 2. Strict input type, presence, and size validation
    if (typeof title !== "string" || !title.trim()) {
      return NextResponse.json(
        { error: "Campaign title is required and must be text" },
        { status: 400 }
      );
    }
    if (title.trim().length > 255) {
      return NextResponse.json(
        { error: "Campaign title cannot exceed 255 characters" },
        { status: 400 }
      );
    }

    if (typeof subject !== "string" || !subject.trim()) {
      return NextResponse.json(
        { error: "Email subject is required and must be text" },
        { status: 400 }
      );
    }
    if (subject.trim().length > 255) {
      return NextResponse.json(
        { error: "Email subject cannot exceed 255 characters" },
        { status: 400 }
      );
    }

    if (typeof contentHtml !== "string" || !contentHtml.trim()) {
      return NextResponse.json(
        { error: "Content HTML is required and must be text" },
        { status: 400 }
      );
    }
    if (contentHtml.length > 500_000) {
      return NextResponse.json(
        { error: "Content HTML exceeds maximum size limit (500KB)" },
        { status: 400 }
      );
    }

    if (previewText !== undefined && previewText !== null) {
      if (typeof previewText !== "string") {
        return NextResponse.json({ error: "Preview text must be a string" }, { status: 400 });
      }
      if (previewText.length > 255) {
        return NextResponse.json({ error: "Preview text cannot exceed 255 characters" }, { status: 400 });
      }
    }

    if (contentPlain !== undefined && contentPlain !== null && typeof contentPlain !== "string") {
      return NextResponse.json({ error: "Content plain must be a string" }, { status: 400 });
    }

    let scheduleDate = new Date();
    if (scheduledAt !== undefined && scheduledAt !== null) {
      scheduleDate = new Date(scheduledAt);
      if (isNaN(scheduleDate.getTime())) {
        return NextResponse.json({ error: "Invalid scheduledAt timestamp" }, { status: 400 });
      }
    }

    // Server-side allowlist HTML sanitization to prevent persistent stored XSS
    const sanitizedHtml = sanitizeNewsletterHtml(contentHtml);

    const isImmediateSend = sendNow === true || !scheduledAt || scheduleDate.getTime() <= Date.now();

    // Transactional Outbox: Atomically persist campaign and outbox job in a single database transaction
    const { campaignId, jobId, issueNumber } = await db.transaction(async (tx) => {
      // 1. Transactional advisory lock: Serialize issue number allocation across concurrent workers
      await tx.execute(sql`SELECT pg_advisory_xact_lock(424242);`);

      // 2. Dynamically sequence the issue number
      const [maxIssue] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${campaigns.issueNumber}), 0)` })
        .from(campaigns);
      const nextIssueNumber = Number(maxIssue?.max || 0) + 1;

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
          issueNumber: nextIssueNumber,
          idempotencyKey: resolvedIdempotencyKey || undefined,
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

      return { campaignId: inserted.id, jobId: enqueuedJobId, issueNumber: nextIssueNumber };
    });

    return NextResponse.json(
      {
        success: true,
        campaignId,
        issueNumber,
        jobId,
        status: isImmediateSend ? "sending" : "scheduled",
        message: isImmediateSend
          ? "Campaign created and enqueued for immediate worker dispatch!"
          : `Campaign scheduled for dispatch at ${scheduleDate.toISOString()}`,
      },
      { status: 201 }
    );
  } catch (err: any) {
    // Graceful recovery for concurrent duplicate requests matching idempotencyKey from headers or JSON body
    if (resolvedIdempotencyKey) {
      try {
        const [existing] = await db
          .select()
          .from(campaigns)
          .where(eq(campaigns.idempotencyKey, resolvedIdempotencyKey));

        if (existing) {
          return NextResponse.json(
            {
              success: true,
              campaignId: existing.id,
              issueNumber: existing.issueNumber,
              status: existing.status,
              duplicate: true,
              message: "Campaign already created with this idempotency key",
            },
            { status: 200 }
          );
        }
      } catch {
        // Fall through to generic error response
      }
    }

    console.error("[Admin Campaign Error]:", err.message);
    return NextResponse.json(
      { error: err?.message || "Failed to create campaign" },
      { status: 500 }
    );
  }
}
