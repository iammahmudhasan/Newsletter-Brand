import { db, automationJobs, eq, sql } from "@ai-signal/db";

export interface EnqueueOptions {
  scheduledFor?: Date;
  maxRetries?: number;
}

/**
 * Durable job enqueueing backed by PostgreSQL
 */
export async function enqueueJob(
  jobName: string,
  payload: Record<string, any>,
  options: EnqueueOptions = {}
): Promise<string> {
  try {
    const [inserted] = await db
      .insert(automationJobs)
      .values({
        jobName,
        payload,
        status: "pending",
        scheduledFor: options.scheduledFor || new Date(),
        maxRetries: options.maxRetries ?? 3,
      })
      .returning({ id: automationJobs.id });

    return inserted.id;
  } catch (err: any) {
    console.error(`[Queue] Failed to enqueue job '${jobName}':`, err.message);
    throw err;
  }
}

/**
 * Claims the next pending job atomically using FOR UPDATE SKIP LOCKED
 */
export async function claimNextJob(
  allowedJobNames?: string[]
): Promise<typeof automationJobs.$inferSelect | null> {
  try {
    // Execute atomic claim query
    const results = await db.transaction(async (tx) => {
      let filterClause = sql`status = 'pending' AND scheduled_for <= NOW()`;

      if (allowedJobNames && allowedJobNames.length > 0) {
        filterClause = sql`${filterClause} AND job_name IN ${allowedJobNames}`;
      }

      const rows = await tx.execute<typeof automationJobs.$inferSelect>(
        sql`
          UPDATE automation_jobs
          SET status = 'processing', locked_at = NOW()
          WHERE id = (
            SELECT id FROM automation_jobs
            WHERE ${filterClause}
            ORDER BY scheduled_for ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING *;
        `
      );

      return (rows as any)?.[0] || null;
    });

    return results;
  } catch (err: any) {
    // If DB is offline or table doesn't exist yet, return null
    return null;
  }
}

/**
 * Marks a job as completed
 */
export async function completeJob(jobId: string): Promise<void> {
  try {
    await db
      .update(automationJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        lockedAt: null,
      })
      .where(eq(automationJobs.id, jobId));
  } catch (err: any) {
    console.error(`[Queue] Failed to complete job ${jobId}:`, err.message);
  }
}

/**
 * Handles job failure with exponential backoff or dead-letter state
 */
export async function failJob(
  jobId: string,
  errorMessage: string
): Promise<void> {
  try {
    const [job] = await db
      .select()
      .from(automationJobs)
      .where(eq(automationJobs.id, jobId));

    if (!job) return;

    const newRetryCount = (job.retryCount || 0) + 1;
    const maxRetries = job.maxRetries || 3;

    if (newRetryCount >= maxRetries) {
      // Move to permanent failure
      await db
        .update(automationJobs)
        .set({
          status: "failed",
          retryCount: newRetryCount,
          lastError: errorMessage,
          lockedAt: null,
        })
        .where(eq(automationJobs.id, jobId));
      console.warn(`[Queue] Job ${jobId} permanently failed after ${newRetryCount} attempts.`);
    } else {
      // Exponential backoff: 30s, 2m, 8m...
      const delaySeconds = Math.pow(4, newRetryCount) * 15;
      const nextRun = new Date(Date.now() + delaySeconds * 1000);

      await db
        .update(automationJobs)
        .set({
          status: "pending",
          retryCount: newRetryCount,
          lastError: errorMessage,
          scheduledFor: nextRun,
          lockedAt: null,
        })
        .where(eq(automationJobs.id, jobId));
      console.log(`[Queue] Job ${jobId} scheduled for retry #${newRetryCount} at ${nextRun.toISOString()}`);
    }
  } catch (err: any) {
    console.error(`[Queue] Error updating failed job ${jobId}:`, err.message);
  }
}
