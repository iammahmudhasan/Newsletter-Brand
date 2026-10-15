import { NextRequest, NextResponse } from "next/server";
import { db, campaigns, eq, sql } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";
import { sanitizeNewsletterHtml } from "@ai-signal/email";
import { campaignCreateSchema } from "@ai-signal/validation";
import { isAuthorizedAdmin } from "@/lib/auth";
import { readBodyWithIncrementalLimit } from "@/lib/bodyLimit";

export async function GET(req: NextRequest) {
  if (!isAuthorizedAdmin(req)) {
    return NextResponse.json(
      { error: "Unauthorized: Valid admin session required" },
      { status: 401 }
    );
  }

  const list = await db
    .select({
      id: campaigns.id,
      issueNumber: campaigns.issueNumber,
      title: campaigns.title,
      subject: campaigns.subject,
      status: campaigns.status,
      scheduledAt: campaigns.scheduledAt,
      sentAt: campaigns.sentAt,
      totalRecipients: campaigns.totalRecipients,
      successfulSends: campaigns.successfulSends,
      failedSends: campaigns.failedSends,
      createdAt: campaigns.createdAt,
      updatedAt: campaigns.updatedAt,
    })
    .from(campaigns)
    .orderBy(sql`${campaigns.issueNumber} DESC`);

  return NextResponse.json({ campaigns: list });
}

export async function POST(req: NextRequest) {
  let resolvedIdempotencyKey: string | null = null;

  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { error: "Unauthorized: Valid admin session required" },
        { status: 401 }
      );
    }

    // 1. Enforce strict stream size and incremental byte limits (1MB maximum payload)
    const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1MB payload limit
    const streamResult = await readBodyWithIncrementalLimit(req, MAX_PAYLOAD_BYTES);
    if ("error" in streamResult) {
      return NextResponse.json(
        { error: streamResult.error },
        { status: streamResult.status }
      );
    }

    let body: any;
    try {
      body = JSON.parse(streamResult.text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON request body" },
        { status: 400 }
      );
    }

    const { scheduledAt, sendNow } = body || {};

    // 2. Request-level idempotency protection: Return existing campaign if key matches
    // Properly fall back to body idempotencyKey if header is empty or whitespace-only
    const headerKey = req.headers.get("idempotency-key")?.trim() || "";
    const bodyKey = (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "")?.trim() || "";
    resolvedIdempotencyKey = (headerKey && headerKey.length > 0) ? headerKey : (bodyKey && bodyKey.length > 0) ? bodyKey : null;

    if (resolvedIdempotencyKey) {
      if (resolvedIdempotencyKey.length > 255) {
        return NextResponse.json(
          { error: "Idempotency key cannot exceed 255 characters" },
          { status: 400 }
        );
      }

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

    // 3. Strict schema validation
    const validation = campaignCreateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error.issues[0]?.message || "Invalid campaign input" },
        { status: 400 }
      );
    }

    const { title, subject, previewText, contentHtml, contentPlain } = validation.data;

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
