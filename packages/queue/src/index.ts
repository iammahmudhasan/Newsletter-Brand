import { db, automationJobs, eq, sql } from "@ai-signal/db";

export interface EnqueueOptions {
  scheduledFor?: Date;
  maxRetries?: number;
  idempotencyKey?: string;
}

/**
 * Durable job enqueueing backed by PostgreSQL with idempotency.
 * Accepts an optional transaction client for atomic outbox patterns.
 */
export async function enqueueJob(
  jobName: string,
  payload: Record<string, any>,
  options: EnqueueOptions = {},
  client: any = db
): Promise<string> {
  try {
    const [inserted] = await client
      .insert(automationJobs)
      .values({
        jobName,
        payload,
        status: "pending",
        scheduledFor: options.scheduledFor || new Date(),
        maxRetries: options.maxRetries ?? 3,
        idempotencyKey: options.idempotencyKey,
      })
      .onConflictDoNothing({ target: automationJobs.idempotencyKey })
      .returning({ id: automationJobs.id });

    return inserted?.id || `idempotent_${options.idempotencyKey}`;
  } catch (err: any) {
    console.error(`[Queue Error] Failed to enqueue job '${jobName}':`, err.message);
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
    console.error("[Queue Error] Database error claiming next job:", err.message);
    return null;
  }
}

/**
 * Reclaims stale jobs stuck in 'processing' due to worker crash or unhandled timeout.
 * Jobs exceeding maxRetries are moved to 'failed'; others are reset to 'pending' for retry.
 */
export async function reclaimStaleJobs(staleMinutes: number = 10): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const staleRows = await tx.execute<typeof automationJobs.$inferSelect>(
        sql`
          SELECT * FROM automation_jobs
          WHERE status = 'processing'
            AND locked_at < NOW() - (INTERVAL '1 minute' * ${staleMinutes})
          FOR UPDATE SKIP LOCKED;
        `
      );

      const jobs = (staleRows as any) || [];
      if (jobs.length === 0) return 0;

      let reclaimedCount = 0;
      for (const job of jobs) {
        const newRetries = (job.retry_count || 0) + 1;
        const maxRetries = job.max_retries || 3;

        if (newRetries >= maxRetries) {
          await tx
            .update(automationJobs)
            .set({
              status: "failed",
              retryCount: newRetries,
              lastError: `Worker lease expired after ${staleMinutes}m (worker crash detected)`,
              lockedAt: null,
            })
            .where(eq(automationJobs.id, job.id));
          console.warn(`[Queue Recovery] Stale job ${job.id} ('${job.job_name}') moved to failed after ${newRetries} attempts.`);
        } else {
          await tx
            .update(automationJobs)
            .set({
              status: "pending",
              retryCount: newRetries,
              lastError: `Worker lease expired after ${staleMinutes}m. Automatically reclaimed for retry #${newRetries}.`,
              lockedAt: null,
              scheduledFor: new Date(),
            })
            .where(eq(automationJobs.id, job.id));
          console.log(`[Queue Recovery] Reclaimed stale job ${job.id} ('${job.job_name}') for retry #${newRetries}.`);
        }
        reclaimedCount++;
      }

      return reclaimedCount;
    });
  } catch (err: any) {
    console.error("[Queue Recovery Error] Failed to reclaim stale jobs:", err.message);
    return 0;
  }
}

/**
 * Renews the lock lease for an actively running job so long-running tasks
 * (e.g. large campaign dispatches) are never prematurely reclaimed as stale.
 */
export async function renewJobLease(jobId: string): Promise<void> {
  try {
    await db
      .update(automationJobs)
      .set({ lockedAt: new Date() })
      .where(eq(automationJobs.id, jobId));
  } catch (err: any) {
    console.warn(`[Queue Lease Warning] Failed to renew lease for job ${jobId}:`, err.message);
  }
}

/**
 * Marks a job as completed
 */
export async function completeJob(jobId: string): Promise<void> {
  try {
    const result = await db
      .update(automationJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        lockedAt: null,
      })
      .where(eq(automationJobs.id, jobId))
      .returning({ id: automationJobs.id });

    if (result.length === 0) {
      console.warn(`[Queue Warning] Attempted to complete job ${jobId}, but row was not found.`);
    }
  } catch (err: any) {
    console.error(`[Queue Error] Failed to complete job ${jobId}:`, err.message);
    throw err;
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

    if (!job) {
      console.warn(`[Queue Warning] Attempted to fail job ${jobId}, but row was not found.`);
      return;
    }

    const newRetryCount = (job.retryCount || 0) + 1;
    const maxRetries = job.maxRetries || 3;

    if (newRetryCount >= maxRetries) {
      await db
        .update(automationJobs)
        .set({
          status: "failed",
          retryCount: newRetryCount,
          lastError: errorMessage,
          lockedAt: null,
        })
        .where(eq(automationJobs.id, jobId));
      console.warn(`[Queue] Job ${jobId} ('${job.jobName}') permanently marked as failed after ${newRetryCount} attempts.`);
    } else {
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
    console.error(`[Queue Error] Error updating failed job ${jobId}:`, err.message);
    throw err;
  }
}
