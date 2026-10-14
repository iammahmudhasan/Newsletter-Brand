import { db, automationJobs, eq, and, sql } from "@ai-signal/db";

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
 * Claims the next pending job atomically using FOR UPDATE SKIP LOCKED.
 * Generates a unique leaseToken to bind the job execution to the specific claiming worker.
 * Returns fields explicitly mapped to camelCase to prevent driver-level snake_case mismatch.
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

      const rows = await tx.execute<any>(
        sql`
          UPDATE automation_jobs
          SET status = 'processing',
              locked_at = NOW(),
              lease_token = gen_random_uuid()
          WHERE id = (
            SELECT id FROM automation_jobs
            WHERE ${filterClause}
            ORDER BY scheduled_for ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING
            id,
            job_name AS "jobName",
            payload,
            status,
            retry_count AS "retryCount",
            max_retries AS "maxRetries",
            last_error AS "lastError",
            idempotency_key AS "idempotencyKey",
            scheduled_for AS "scheduledFor",
            locked_at AS "lockedAt",
            lease_token AS "leaseToken",
            completed_at AS "completedAt",
            created_at AS "createdAt";
        `
      );

      const raw = (rows as any)?.[0];
      if (!raw) return null;

      // Normalization: Ensure camelCase properties are ALWAYS populated regardless of driver casing
      return {
        id: raw.id,
        jobName: raw.jobName ?? raw.job_name,
        payload: raw.payload,
        status: raw.status,
        retryCount: raw.retryCount ?? raw.retry_count ?? 0,
        maxRetries: raw.maxRetries ?? raw.max_retries ?? 3,
        lastError: raw.lastError ?? raw.last_error ?? null,
        idempotencyKey: raw.idempotencyKey ?? raw.idempotency_key ?? null,
        scheduledFor: raw.scheduledFor ?? raw.scheduled_for ?? null,
        lockedAt: raw.lockedAt ?? raw.locked_at ?? null,
        leaseToken: raw.leaseToken ?? raw.lease_token ?? null,
        completedAt: raw.completedAt ?? raw.completed_at ?? null,
        createdAt: raw.createdAt ?? raw.created_at,
      } as typeof automationJobs.$inferSelect;
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
 * Invalidates the previous leaseToken to prevent stale workers from mutating reclaimed jobs.
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
              leaseToken: null,
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
 * Fenced with leaseToken to ensure only the active lease owner can renew.
 * Missing leaseToken fails closed immediately.
 */
export async function renewJobLease(jobId: string, leaseToken: string): Promise<boolean> {
  if (!jobId || !leaseToken) {
    console.error(`[Queue Security Alert] renewJobLease called without mandatory jobId or leaseToken. Failing closed.`);
    return false;
  }

  try {
    const result = await db
      .update(automationJobs)
      .set({ lockedAt: new Date() })
      .where(
        and(
          eq(automationJobs.id, jobId),
          eq(automationJobs.status, "processing"),
          eq(automationJobs.leaseToken, leaseToken)
        )
      )
      .returning({ id: automationJobs.id });

    return result.length > 0;
  } catch (err: any) {
    console.warn(`[Queue Lease Warning] Failed to renew lease for job ${jobId}:`, err.message);
    return false;
  }
}

/**
 * Marks a job as completed.
 * Fenced with mandatory leaseToken and 'processing' status to prevent stale workers from completing reclaimed jobs.
 * Missing leaseToken fails closed immediately.
 */
export async function completeJob(jobId: string, leaseToken: string): Promise<boolean> {
  if (!jobId || !leaseToken) {
    console.error(`[Queue Security Alert] completeJob called without mandatory jobId or leaseToken. Failing closed.`);
    return false;
  }

  try {
    const result = await db
      .update(automationJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        lockedAt: null,
      })
      .where(
        and(
          eq(automationJobs.id, jobId),
          eq(automationJobs.status, "processing"),
          eq(automationJobs.leaseToken, leaseToken)
        )
      )
      .returning({ id: automationJobs.id });

    if (result.length === 0) {
      console.warn(`[Queue Warning] Attempted to complete job ${jobId}, but lease token mismatched or job is not in 'processing' state.`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[Queue Error] Failed to complete job ${jobId}:`, err.message);
    throw err;
  }
}

/**
 * Handles job failure with exponential backoff or dead-letter state.
 * Fenced with mandatory leaseToken and 'processing' status so stale workers cannot fail a reclaimed active job.
 * Missing leaseToken fails closed immediately.
 */
export async function failJob(
  jobId: string,
  errorMessage: string,
  leaseToken: string
): Promise<boolean> {
  if (!jobId || !leaseToken) {
    console.error(`[Queue Security Alert] failJob called without mandatory jobId or leaseToken. Failing closed.`);
    return false;
  }

  try {
    const [job] = await db
      .select()
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.id, jobId),
          eq(automationJobs.status, "processing"),
          eq(automationJobs.leaseToken, leaseToken)
        )
      );

    if (!job) {
      console.warn(`[Queue Warning] Attempted to fail job ${jobId}, but job is not in 'processing' state or lease token mismatched.`);
      return false;
    }

    const newRetryCount = (job.retryCount || 0) + 1;
    const maxRetries = job.maxRetries || 3;

    if (newRetryCount >= maxRetries) {
      const result = await db
        .update(automationJobs)
        .set({
          status: "failed",
          retryCount: newRetryCount,
          lastError: errorMessage,
          lockedAt: null,
        })
        .where(
          and(
            eq(automationJobs.id, jobId),
            eq(automationJobs.status, "processing"),
            eq(automationJobs.leaseToken, leaseToken)
          )
        )
        .returning({ id: automationJobs.id });
      console.warn(`[Queue] Job ${jobId} ('${job.jobName}') permanently marked as failed after ${newRetryCount} attempts.`);
      return result.length > 0;
    } else {
      const delaySeconds = Math.pow(4, newRetryCount) * 15;
      const nextRun = new Date(Date.now() + delaySeconds * 1000);

      const result = await db
        .update(automationJobs)
        .set({
          status: "pending",
          retryCount: newRetryCount,
          lastError: errorMessage,
          scheduledFor: nextRun,
          lockedAt: null,
          leaseToken: null,
        })
        .where(
          and(
            eq(automationJobs.id, jobId),
            eq(automationJobs.status, "processing"),
            eq(automationJobs.leaseToken, leaseToken)
          )
        )
        .returning({ id: automationJobs.id });
      console.log(`[Queue] Job ${jobId} scheduled for retry #${newRetryCount} at ${nextRun.toISOString()}`);
      return result.length > 0;
    }
  } catch (err: any) {
    console.error(`[Queue Error] Error updating failed job ${jobId}:`, err.message);
    throw err;
  }
}
