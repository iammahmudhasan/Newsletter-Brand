import { NextRequest, NextResponse } from "next/server";
import { db, campaigns } from "@ai-signal/db";
import { enqueueJob } from "@ai-signal/queue";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, subject, previewText, contentHtml, contentPlain } = body;

    if (!title || !subject || !contentHtml) {
      return NextResponse.json(
        { error: "Title, Subject, and Content HTML are required" },
        { status: 400 }
      );
    }

    // 1. Create campaign in DB
    const [inserted] = await db
      .insert(campaigns)
      .values({
        title,
        subject,
        previewText: previewText || "",
        contentHtml,
        contentPlain: contentPlain || "",
        status: "scheduled",
        scheduledAt: new Date(),
      })
      .returning({ id: campaigns.id });

    // 2. Enqueue background campaign dispatch job
    const jobId = await enqueueJob("process_campaign", {
      campaignId: inserted.id,
    });

    return NextResponse.json(
      {
        success: true,
        campaignId: inserted.id,
        jobId,
        message: "Campaign created and enqueued for worker dispatch!",
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
