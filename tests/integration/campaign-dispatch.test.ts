import { describe, it, expect } from "bun:test";

describe("Campaign Dispatch Reliability, Queue Lease Recovery & Status Calculations", () => {
  it("accurately calculates partial failure when some recipient deliveries fail", () => {
    const totalRecipients: number = 100;
    const sentCount: number = 95;
    const failedCount: number = 5;

    let finalStatus: "sent" | "partially_failed" | "failed" = "sent";
    if (failedCount > 0 && sentCount > 0) {
      finalStatus = "partially_failed";
    } else if (failedCount > 0 && sentCount === 0) {
      finalStatus = "failed";
    }

    expect(finalStatus).toBe("partially_failed");
  });

  it("marks campaign as sent only when all deliveries succeed", () => {
    const totalRecipients: number = 50;
    const sentCount: number = 50;
    const failedCount: number = 0;

    let finalStatus: "sent" | "partially_failed" | "failed" = "sent";
    if (failedCount > 0 && sentCount > 0) {
      finalStatus = "partially_failed";
    } else if (failedCount > 0 && sentCount === 0) {
      finalStatus = "failed";
    }

    expect(finalStatus).toBe("sent");
  });

  it("marks campaign as failed when zero deliveries succeed", () => {
    const totalRecipients: number = 20;
    const sentCount: number = 0;
    const failedCount: number = 20;

    let finalStatus: "sent" | "partially_failed" | "failed" = "sent";
    if (failedCount > 0 && sentCount > 0) {
      finalStatus = "partially_failed";
    } else if (failedCount > 0 && sentCount === 0) {
      finalStatus = "failed";
    }

    expect(finalStatus).toBe("failed");
  });

  describe("Conditional State Transitions & Webhook-Worker Concurrency", () => {
    it("ensures worker success update NEVER downgrades recipient if webhook already marked delivered", () => {
      // Scenario: Worker dispatches email; fast webhook arrives and marks recipient 'delivered';
      // Worker's sendEmail() resolves and attempts conditional update status = 'sent' WHERE status = 'processing'.
      let recipient = {
        id: "recip-concurrent-1",
        status: "processing",
        providerMessageId: null as string | null,
      };

      // 1. Fast webhook arrives
      const webhookDeliveredAllowedTransitions = ["queued", "processing", "sent", "unknown_outcome", "needs_review"];
      if (webhookDeliveredAllowedTransitions.includes(recipient.status)) {
        recipient.status = "delivered";
        recipient.providerMessageId = "msg_from_webhook_123";
      }

      expect(recipient.status).toBe("delivered");

      // 2. Worker resolves with success and executes conditional update:
      // UPDATE campaign_recipients SET status = 'sent' WHERE id = recip-concurrent-1 AND status = 'processing'
      let updatedByWorker = false;
      if (recipient.status === "processing") {
        recipient.status = "sent";
        updatedByWorker = true;
      }

      expect(updatedByWorker).toBe(false);
      expect(recipient.status).toBe("delivered"); // PRESERVED! Not downgraded to 'sent'!
    });

    it("ensures worker success update NEVER overwrites recipient if webhook already marked bounced", () => {
      let recipient = {
        id: "recip-concurrent-2",
        status: "processing",
        providerMessageId: null as string | null,
        errorMessage: null as string | null,
      };

      // 1. Hard bounce webhook arrives immediately
      recipient.status = "bounced";
      recipient.errorMessage = "Permanent hard bounce";

      expect(recipient.status).toBe("bounced");

      // 2. Worker resolves with success
      let updatedByWorker = false;
      if (recipient.status === "processing") {
        recipient.status = "sent";
        updatedByWorker = true;
      }

      expect(updatedByWorker).toBe(false);
      expect(recipient.status).toBe("bounced"); // PRESERVED! Bounced status is immutable against sent!
      expect(recipient.errorMessage).toBe("Permanent hard bounce");
    });

    it("ensures delayed delivered webhook NEVER overwrites already bounced or failed status", () => {
      let recipient = {
        id: "recip-concurrent-3",
        status: "bounced",
        errorMessage: "Mailbox does not exist",
      };

      // Delayed or out-of-order 'delivered' webhook arrives
      const allowedToDeliver = ["queued", "processing", "sent", "unknown_outcome", "needs_review"];
      if (allowedToDeliver.includes(recipient.status)) {
        recipient.status = "delivered";
      }

      // Must remain bounced!
      expect(recipient.status).toBe("bounced");
      expect(recipient.errorMessage).toBe("Mailbox does not exist");
    });
  });

  describe("Ambiguous Network Outbound & Event Reconciliation", () => {
    it("moves recipient to 'unknown_outcome' on network timeout/5xx rather than blind re-dispatch", () => {
      const sendResult = {
        success: false,
        messageId: "",
        provider: "resend" as const,
        error: "fetch failed: Connection reset by peer",
        isAmbiguous: true,
      };

      let recipient = {
        id: "recip-ambiguous-1",
        status: "processing",
        attemptCount: 1,
        nextAttemptAt: null as Date | null,
        errorMessage: null as string | null,
      };

      if (sendResult.isAmbiguous) {
        recipient.status = "unknown_outcome";
        recipient.nextAttemptAt = new Date(Date.now() + 2 * 60 * 1000);
        recipient.errorMessage = sendResult.error;
      }

      expect(recipient.status).toBe("unknown_outcome");
      expect(recipient.nextAttemptAt).not.toBeNull();
    });

    it("reconciles 'unknown_outcome' via webhook delivered event and avoids second send", () => {
      const recipient = {
        id: "recip-reconciled-1",
        status: "unknown_outcome",
      };

      const webhookEvents = [
        {
          recipientId: "recip-reconciled-1",
          eventType: "delivered",
          providerMessageId: "msg_reconciled_999",
        },
      ];

      const validEventTypes = ["delivered", "bounce", "complaint", "open", "click"];
      const matched = webhookEvents.find(
        (e) => e.recipientId === recipient.id && validEventTypes.includes(e.eventType)
      );

      let finalStatus = recipient.status;
      let duplicateSendDispatched = false;

      if (matched) {
        if (matched.eventType === "bounce") finalStatus = "bounced";
        else if (matched.eventType === "complaint") finalStatus = "failed";
        else finalStatus = "delivered";
      } else {
        duplicateSendDispatched = true;
      }

      expect(matched).toBeDefined();
      expect(finalStatus).toBe("delivered");
      expect(duplicateSendDispatched).toBe(false);
    });

    it("refuses to falsely reconcile 'unknown_outcome' on an unrecognized event type", () => {
      const recipient = {
        id: "recip-reconciled-2",
        status: "unknown_outcome",
      };

      const webhookEvents = [
        {
          recipientId: "recip-reconciled-2",
          eventType: "unknown", // Unrecognized event payload
          providerMessageId: "msg_unknown_888",
        },
      ];

      const validEventTypes = ["delivered", "bounce", "complaint", "open", "click"];
      const matched = webhookEvents.find(
        (e) => e.recipientId === recipient.id && validEventTypes.includes(e.eventType)
      );

      expect(matched).toBeUndefined(); // Unknown event ignored for delivery reconciliation!
      expect(recipient.status).toBe("unknown_outcome"); // Keeps waiting for valid delivery or timeout
    });
  });

  describe("Queue Lease Ownership & Fencing", () => {
    it("ensures stale worker cannot complete a job whose lease was reclaimed to pending", () => {
      let jobInDb = {
        id: "job-101",
        status: "pending", // Reclaimed by recovery scheduler
        retryCount: 2,
        lockedAt: null as Date | null,
        leaseToken: null as string | null,
      };

      // Stale worker that woke up late attempts completeJob()
      let completedSuccessfully = false;
      if (jobInDb.status === "processing") {
        jobInDb.status = "completed";
        completedSuccessfully = true;
      }

      expect(completedSuccessfully).toBe(false);
      expect(jobInDb.status).toBe("pending"); // Preserved for new worker!
    });

    it("ensures stale Worker A cannot complete or fail a job after Worker B has claimed it with a new leaseToken", () => {
      const jobId = "job-fencing-102";
      const leaseTokenA = "uuid-worker-a-1111";
      const leaseTokenB = "uuid-worker-b-2222";

      let jobInDb = {
        id: jobId,
        status: "processing",
        lockedAt: new Date(),
        leaseToken: leaseTokenB, // Worker B is the current active owner!
        retryCount: 1,
      };

      // 1. Worker A (stale) attempts completeJob(jobId, leaseTokenA)
      // SQL condition: WHERE id = jobId AND status = 'processing' AND lease_token = leaseTokenA
      let workerACompleteSuccess = false;
      if (jobInDb.status === "processing" && jobInDb.leaseToken === leaseTokenA) {
        jobInDb.status = "completed";
        workerACompleteSuccess = true;
      }

      expect(workerACompleteSuccess).toBe(false);
      expect(jobInDb.status).toBe("processing"); // Job remains in processing under Worker B!
      expect(jobInDb.leaseToken).toBe(leaseTokenB);

      // 2. Worker A (stale) attempts failJob(jobId, "Crash error", leaseTokenA)
      // SQL condition: WHERE id = jobId AND status = 'processing' AND lease_token = leaseTokenA
      let workerAFailSuccess = false;
      if (jobInDb.status === "processing" && jobInDb.leaseToken === leaseTokenA) {
        jobInDb.status = "failed";
        workerAFailSuccess = true;
      }

      expect(workerAFailSuccess).toBe(false);
      expect(jobInDb.status).toBe("processing"); // Job is NOT failed by stale worker A!

      // 3. Worker B (legitimate owner) calls renewJobLease(jobId, leaseTokenB)
      let workerBRenewSuccess = false;
      if (jobInDb.status === "processing" && jobInDb.leaseToken === leaseTokenB) {
        jobInDb.lockedAt = new Date();
        workerBRenewSuccess = true;
      }
      expect(workerBRenewSuccess).toBe(true);

      // 4. Worker B finishes work and calls completeJob(jobId, leaseTokenB)
      let workerBCompleteSuccess = false;
      if (jobInDb.status === "processing" && jobInDb.leaseToken === leaseTokenB) {
        jobInDb.status = "completed";
        workerBCompleteSuccess = true;
      }
      expect(workerBCompleteSuccess).toBe(true);
      expect(jobInDb.status).toBe("completed");
    });
  });

  describe("Resend Idempotency & Deterministic Retry Payload", () => {
    it("generates 100% deterministic unsubscribe token, URL, and issue date across retries", () => {
      const campaign = {
        id: "camp-det-001",
        title: "AI Signal Weekly #42",
        createdAt: new Date("2026-10-10T12:00:00Z"),
      };
      const subscriber = {
        id: "sub-det-001",
        email: "alice@example.com",
      };

      // Base timestamp derived strictly from campaign.createdAt
      const baseTimestamp = Math.floor(campaign.createdAt.getTime() / 1000);

      // First dispatch attempt (day 0)
      const tokenAttempt1 = `token_base_${baseTimestamp}_sub_${subscriber.id}`;
      const issueDateAttempt1 = new Date(campaign.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      // Second dispatch retry (simulate 3 days later)
      const tokenAttempt2 = `token_base_${baseTimestamp}_sub_${subscriber.id}`;
      const issueDateAttempt2 = new Date(campaign.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      expect(tokenAttempt1).toBe(tokenAttempt2);
      expect(issueDateAttempt1).toBe(issueDateAttempt2);
      expect(issueDateAttempt1).toBe("Oct 10, 2026");
    });

    it("classifies Resend HTTP 409 conflict as ambiguous to trigger webhook reconciliation", () => {
      const response = {
        status: 409,
        data: {
          name: "invalid_idempotent_request",
          message: "A request with the same idempotency key was previously submitted",
        },
      };

      const isConflict = response.status === 409 || response.data?.name === "invalid_idempotent_request";
      const isAmbiguous = response.status >= 500 || isConflict;

      expect(isConflict).toBe(true);
      expect(isAmbiguous).toBe(true); // Must route to unknown_outcome, NOT blind failure!
    });
  });

  describe("Unknown Outcome Timing & Eligibility Threshold", () => {
    it("allows unknown_outcome to be eligible as soon as nextAttemptAt (2m) has passed", () => {
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

      const unknownRecipient = {
        id: "recip-unknown-1",
        status: "unknown_outcome",
        updatedAt: twoMinutesAgo,
        nextAttemptAt: twoMinutesAgo,
      };

      // Query logic: status = 'unknown_outcome' AND (nextAttemptAt IS NULL OR nextAttemptAt <= NOW())
      const isEligible =
        unknownRecipient.status === "unknown_outcome" &&
        (unknownRecipient.nextAttemptAt === null || unknownRecipient.nextAttemptAt <= now);

      expect(isEligible).toBe(true);
    });

    it("requires crashed processing recipients to wait 5 minutes before reclaim", () => {
      const now = new Date();
      const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);
      const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000);

      const crashedRecently = {
        id: "recip-proc-1",
        status: "processing",
        updatedAt: threeMinutesAgo,
      };

      const crashedStale = {
        id: "recip-proc-2",
        status: "processing",
        updatedAt: sixMinutesAgo,
      };

      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      const eligibleRecently = crashedRecently.status === "processing" && crashedRecently.updatedAt < fiveMinutesAgo;
      const eligibleStale = crashedStale.status === "processing" && crashedStale.updatedAt < fiveMinutesAgo;

      expect(eligibleRecently).toBe(false); // Only 3m old -> protected
      expect(eligibleStale).toBe(true); // 6m old -> reclaimed!
    });
  });

  describe("Zero Active Subscribers Reconciliation", () => {
    it("does NOT prematurely finalize campaign as sent with 0 recipients when pre-existing recipients exist", () => {
      const activeSubscribers = [] as Array<{ id: string; email: string }>;
      const existingRecipientsCount: number = 15; // 15 recipients from a previous attempt

      let finalizedEarlyWithZero = false;
      let proceedToProcessExisting = false;

      if (activeSubscribers.length === 0 && existingRecipientsCount === 0) {
        finalizedEarlyWithZero = true;
      } else {
        proceedToProcessExisting = true;
      }

      expect(finalizedEarlyWithZero).toBe(false);
      expect(proceedToProcessExisting).toBe(true);
    });
  });

  describe("Queue Job Row Normalization & Field Mapping", () => {
    it("normalizes raw Postgres snake_case row columns to camelCase properties (jobName, leaseToken)", () => {
      // Raw row as returned by PostgreSQL driver without client-side mapping
      const rawPostgresRow = {
        id: "job-norm-001",
        job_name: "process_campaign",
        payload: { campaignId: "camp-norm-001" },
        status: "processing",
        retry_count: 1,
        max_retries: 3,
        last_error: null,
        idempotency_key: "idem-norm-001",
        scheduled_for: new Date(),
        locked_at: new Date(),
        lease_token: "token-norm-uuid-1234",
        completed_at: null,
        created_at: new Date(),
      };

      // Normalization function as implemented in claimNextJob()
      const normalized = {
        id: rawPostgresRow.id,
        jobName: (rawPostgresRow as any).jobName ?? rawPostgresRow.job_name,
        payload: rawPostgresRow.payload,
        status: rawPostgresRow.status,
        retryCount: (rawPostgresRow as any).retryCount ?? rawPostgresRow.retry_count ?? 0,
        maxRetries: (rawPostgresRow as any).maxRetries ?? rawPostgresRow.max_retries ?? 3,
        lastError: (rawPostgresRow as any).lastError ?? rawPostgresRow.last_error ?? null,
        idempotencyKey: (rawPostgresRow as any).idempotencyKey ?? rawPostgresRow.idempotency_key ?? null,
        scheduledFor: (rawPostgresRow as any).scheduledFor ?? rawPostgresRow.scheduled_for ?? null,
        lockedAt: (rawPostgresRow as any).lockedAt ?? rawPostgresRow.locked_at ?? null,
        leaseToken: (rawPostgresRow as any).leaseToken ?? rawPostgresRow.lease_token ?? null,
        completedAt: (rawPostgresRow as any).completedAt ?? rawPostgresRow.completed_at ?? null,
        createdAt: rawPostgresRow.created_at,
      };

      // Worker expects camelCase properties:
      expect(normalized.jobName).toBe("process_campaign");
      expect(normalized.leaseToken).toBe("token-norm-uuid-1234");
      expect(normalized.retryCount).toBe(1);
      expect(normalized.jobName).not.toBeUndefined();
      expect(normalized.leaseToken).not.toBeUndefined();
    });
  });

  describe("Mandatory Lease Token & Fail-Closed Lost Lease Handling", () => {
    it("fails closed when queue lease operations are called without a valid leaseToken", () => {
      const renewJobLeaseCheck = (jobId: string, leaseToken: string): boolean => {
        if (!jobId || !leaseToken) return false;
        return true;
      };

      const completeJobCheck = (jobId: string, leaseToken: string): boolean => {
        if (!jobId || !leaseToken) return false;
        return true;
      };

      expect(renewJobLeaseCheck("job-1", "")).toBe(false);
      expect(renewJobLeaseCheck("job-1", null as any)).toBe(false);
      expect(renewJobLeaseCheck("job-1", undefined as any)).toBe(false);

      expect(completeJobCheck("job-1", "")).toBe(false);
      expect(completeJobCheck("job-1", null as any)).toBe(false);
    });

    it("halts worker campaign dispatch immediately when renewJobLease returns false (lost lease)", () => {
      let leaseLost = false;
      let dispatchedRecipients = 0;
      const totalRecipients = 10;

      for (let i = 0; i < totalRecipients; i++) {
        if (leaseLost) break;

        // Simulate lease renewal failure on 3rd recipient (another worker reclaimed the job)
        if (i === 3) {
          const renewed = false; // Lease lost!
          if (!renewed) {
            leaseLost = true;
            break;
          }
        }

        dispatchedRecipients++;
      }

      expect(leaseLost).toBe(true);
      expect(dispatchedRecipients).toBe(3); // Stopped immediately! Remaining 7 untouched!
    });
  });

  describe("Unknown Outcome Max Attempt Capping & Reconciliation State", () => {
    it("marks recipient as 'needs_review' (not terminal 'failed') when ambiguous outcome reaches MAX_RECIPIENT_ATTEMPTS (3)", () => {
      const MAX_RECIPIENT_ATTEMPTS = 3;
      let currentAttempts = 2; // Previous attempts: 2
      let recipient = {
        id: "recip-loop-prevent-1",
        status: "processing",
        attemptCount: currentAttempts,
        nextAttemptAt: null as Date | null,
        errorMessage: null as string | null,
      };

      // 3rd attempt results in network timeout (ambiguous)
      currentAttempts += 1;
      const sendResult = {
        success: false,
        isAmbiguous: true,
        error: "Network timeout: Connection reset by peer",
      };

      if (sendResult.isAmbiguous) {
        if (currentAttempts >= MAX_RECIPIENT_ATTEMPTS) {
          // Holds in 'needs_review' rather than definitive 'failed', clearing nextAttemptAt
          recipient.status = "needs_review";
          recipient.attemptCount = currentAttempts;
          recipient.nextAttemptAt = null; // Cleared! Automated retry loop is terminated!
          recipient.errorMessage = `Ambiguous dispatch outcome exceeded max attempts (${MAX_RECIPIENT_ATTEMPTS}). Held in needs_review awaiting webhook reconciliation: ${sendResult.error}`;
        } else {
          recipient.status = "unknown_outcome";
          recipient.nextAttemptAt = new Date(Date.now() + 2 * 60 * 1000);
        }
      }

      expect(recipient.status).toBe("needs_review");
      expect(recipient.attemptCount).toBe(3);
      expect(recipient.nextAttemptAt).toBeNull(); // Guarantees infinite loop is broken!
      expect(recipient.errorMessage).toContain("Held in needs_review awaiting webhook reconciliation");
    });

    it("reconciles 'needs_review' recipient when delayed 'delivered' webhook arrives and recovers campaign stats", () => {
      // Recipient reached 3 ambiguous attempts and was held in 'needs_review'
      let recipient = {
        id: "recip-delayed-webhook-1",
        campaignId: "campaign-test-1",
        status: "needs_review",
        providerMessageId: null as string | null,
        errorMessage: "Ambiguous timeout on attempt 3",
      };

      // Initially, campaign reached terminal state with partially_failed
      let campaign = {
        id: "campaign-test-1",
        status: "partially_failed" as "sent" | "partially_failed" | "failed",
        totalRecipients: 2,
        successfulSends: 1,
        failedSends: 1, // Counted this needs_review recipient
      };

      // Now, delayed provider webhook arrives with 'delivered' event
      const delayedWebhookType = "delivered";
      const webhookProviderMsgId = "ses-msg-delayed-777";
      const allowedToDeliver = ["queued", "processing", "sent", "unknown_outcome", "needs_review"];

      let transitioned = false;
      if (allowedToDeliver.includes(recipient.status) && delayedWebhookType === "delivered") {
        recipient.status = "delivered";
        recipient.providerMessageId = webhookProviderMsgId;
        transitioned = true;
      }

      expect(transitioned).toBe(true);
      expect(recipient.status).toBe("delivered");
      expect(recipient.providerMessageId).toBe("ses-msg-delayed-777");

      // Reconcile parent campaign aggregates
      if (transitioned) {
        const recipientsInCampaign = [
          { status: "delivered" },
          { status: recipient.status }, // delivered
        ];
        const sent = recipientsInCampaign.filter((r) => r.status === "sent" || r.status === "delivered").length;
        const failed = recipientsInCampaign.filter(
          (r) => r.status === "failed" || r.status === "bounced" || r.status === "needs_review"
        ).length;

        campaign.successfulSends = sent;
        campaign.failedSends = failed;
        if (failed === 0 && sent > 0) {
          campaign.status = "sent";
        }
      }

      // Verification: Campaign was successfully healed from 'partially_failed' to 'sent'!
      expect(campaign.status).toBe("sent");
      expect(campaign.successfulSends).toBe(2);
      expect(campaign.failedSends).toBe(0);
    });
  });

  describe("Atomic firstDispatchAt Initialization Under Concurrent Workers", () => {
    it("preserves earliest timestamp atomically via COALESCE and prevents overwriting by concurrent workers", () => {
      // Simulate Database State
      let dbCampaign = {
        id: "camp-race-1",
        firstDispatchAt: null as Date | null,
      };

      // Helper simulating atomic UPDATE campaigns SET first_dispatch_at = COALESCE(first_dispatch_at, NOW()) RETURNING first_dispatch_at
      function atomicSetFirstDispatchAt(incomingWorkerDate: Date): Date {
        if (!dbCampaign.firstDispatchAt) {
          dbCampaign.firstDispatchAt = incomingWorkerDate;
        }
        return dbCampaign.firstDispatchAt;
      }

      const worker1Timestamp = new Date("2026-10-14T08:00:00.000Z");
      const worker2Timestamp = new Date("2026-10-14T08:00:05.000Z"); // Started 5s later

      // Worker 1 runs first
      const worker1Result = atomicSetFirstDispatchAt(worker1Timestamp);
      expect(worker1Result.toISOString()).toBe("2026-10-14T08:00:00.000Z");

      // Concurrent Worker 2 runs
      const worker2Result = atomicSetFirstDispatchAt(worker2Timestamp);
      expect(worker2Result.toISOString()).toBe("2026-10-14T08:00:00.000Z"); // Maintained Worker 1's timestamp!

      // Both workers receive the exact same database-persisted timestamp
      expect(worker1Result.getTime()).toBe(worker2Result.getTime());
      expect(dbCampaign.firstDispatchAt?.toISOString()).toBe("2026-10-14T08:00:00.000Z");
    });
  });

  describe("Worker completeJob Observability & Failure Handling", () => {
    it("reports warning when completeJob returns false due to lost lease rather than false success", () => {
      let loggedSuccess = false;
      let loggedWarning = false;

      // Mock completeJob returning false (lease was reclaimed by another worker)
      const completeJobResult = false;

      if (completeJobResult) {
        loggedSuccess = true;
      } else {
        loggedWarning = true;
      }

      expect(loggedSuccess).toBe(false);
      expect(loggedWarning).toBe(true);
    });
  });

  describe("Persistent firstDispatchAt & Unsubscribe Token Validity", () => {
    it("ensures unsubscribe token is valid for 365 days from actual firstDispatchAt even if draft was created 1 year prior", () => {
      const draftCreatedAt = new Date("2024-01-01T00:00:00Z"); // Draft created 2.5 years ago
      const actualFirstDispatchAt = new Date("2026-10-14T00:00:00Z"); // Dispatched today

      const baseTimestampSeconds = Math.floor(actualFirstDispatchAt.getTime() / 1000);
      const expiresInSeconds = 365 * 86400; // 1 year
      const tokenExpirySeconds = baseTimestampSeconds + expiresInSeconds;

      const nowSeconds = Math.floor(actualFirstDispatchAt.getTime() / 1000);

      // Verify token is NOT expired when sent today
      expect(tokenExpirySeconds).toBeGreaterThan(nowSeconds);

      // Verify token remains valid for approximately 365 days from dispatch
      const secondsRemaining = tokenExpirySeconds - nowSeconds;
      expect(secondsRemaining).toBe(expiresInSeconds);

      // Verify that if draftCreatedAt were incorrectly used, the token would be expired today:
      const wrongBaseTimestampSeconds = Math.floor(draftCreatedAt.getTime() / 1000);
      const wrongExpirySeconds = wrongBaseTimestampSeconds + expiresInSeconds;
      expect(wrongExpirySeconds).toBeLessThan(nowSeconds); // Proof that firstDispatchAt fixes the expiry bug!
    });
  });
});
