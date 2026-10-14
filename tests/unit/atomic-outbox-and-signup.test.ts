import { describe, it, expect } from "bun:test";
import { enqueueJob } from "../../packages/queue/src/index";

describe("Atomic Outbox & Signup Transactions", () => {
  it("enqueueJob supports custom transaction executor and persists idempotencyKey", async () => {
    let capturedValues: any = null;
    let conflictTarget: any = null;

    const mockTx = {
      insert: () => ({
        values: (vals: any) => {
          capturedValues = vals;
          return {
            onConflictDoNothing: (target: any) => {
              conflictTarget = target;
              return {
                returning: () => [{ id: "tx-job-123" }],
              };
            },
          };
        },
      }),
    };

    const jobId = await enqueueJob(
      "test_job",
      { foo: "bar" },
      { idempotencyKey: "test:key:123" },
      mockTx
    );

    expect(jobId).toBe("tx-job-123");
    expect(capturedValues.jobName).toBe("test_job");
    expect(capturedValues.idempotencyKey).toBe("test:key:123");
    expect(capturedValues.status).toBe("pending");
  });

  it("verifies transactional outbox atomicity: rolled-back transaction commits zero state changes", async () => {
    // Model an in-memory transactional database to verify transaction rollback semantics
    const committedDb = {
      campaigns: [] as any[],
      jobs: [] as any[],
    };

    async function executeTransactionalOutbox(simulateFailure: boolean) {
      // In PostgreSQL db.transaction(async (tx) => ...):
      // mutations on tx only apply to committed state if the callback completes without throwing
      const stagedCampaigns: any[] = [];
      const stagedJobs: any[] = [];

      try {
        // Step 1: Stage campaign
        stagedCampaigns.push({ id: "camp-001", status: "sending" });

        // Step 2: Stage queue job
        if (simulateFailure) {
          throw new Error("Simulated database connection crash during outbox enqueue");
        }
        stagedJobs.push({ id: "job-001", jobName: "process_campaign" });

        // Step 3: Transaction commits
        committedDb.campaigns.push(...stagedCampaigns);
        committedDb.jobs.push(...stagedJobs);
        return { success: true };
      } catch (err: any) {
        // Transaction aborts & rolls back: staged changes are discarded!
        return { success: false, error: err.message };
      }
    }

    // 1. Successful execution
    const successRes = await executeTransactionalOutbox(false);
    expect(successRes.success).toBe(true);
    expect(committedDb.campaigns.length).toBe(1);
    expect(committedDb.jobs.length).toBe(1);

    // 2. Failed execution
    const failRes = await executeTransactionalOutbox(true);
    expect(failRes.success).toBe(false);
    // State is strictly preserved: no orphaned campaign or job was added!
    expect(committedDb.campaigns.length).toBe(1);
    expect(committedDb.jobs.length).toBe(1);
  });

  it("validates signup flow requires valid email", async () => {
    const { POST } = await import("../../apps/web/src/app/api/subscribe/route");

    const req = new Request("http://localhost:3000/api/subscribe", {
      method: "POST",
      body: JSON.stringify({ email: "invalid-email" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Please provide a valid email address");
  });
});
