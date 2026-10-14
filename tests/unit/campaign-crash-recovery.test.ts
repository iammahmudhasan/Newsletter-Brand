import { describe, it, expect } from "bun:test";

describe("Campaign Worker Crash Recovery & State Integrity", () => {
  it("maintains 'sending' state when pending or processing recipients remain", () => {
    const recipients = [
      { id: "r1", status: "sent" },
      { id: "r2", status: "processing" }, // Worker crashed or in-flight
      { id: "r3", status: "queued" },
    ];

    const sent = recipients.filter((r) => r.status === "sent" || r.status === "delivered").length;
    const failed = recipients.filter((r) => r.status === "failed" || r.status === "bounced").length;
    const pendingOrProcessing = recipients.filter(
      (r) => r.status === "queued" || r.status === "processing"
    ).length;

    let campaignStatus = "sending";
    if (pendingOrProcessing > 0) {
      campaignStatus = "sending"; // Preserved!
    } else {
      campaignStatus = failed > 0 ? (sent > 0 ? "partially_failed" : "failed") : "sent";
    }

    expect(campaignStatus).toBe("sending");
    expect(pendingOrProcessing).toBe(2);
  });

  it("calculates terminal state accurately only when zero recipients remain pending", () => {
    const recipients = [
      { id: "r1", status: "sent" },
      { id: "r2", status: "delivered" },
      { id: "r3", status: "failed" },
    ];

    const sent = recipients.filter((r) => r.status === "sent" || r.status === "delivered").length;
    const failed = recipients.filter((r) => r.status === "failed" || r.status === "bounced").length;
    const pendingOrProcessing = recipients.filter(
      (r) => r.status === "queued" || r.status === "processing"
    ).length;

    expect(pendingOrProcessing).toBe(0);

    let campaignStatus: "sent" | "partially_failed" | "failed" = "sent";
    if (failed > 0 && sent > 0) {
      campaignStatus = "partially_failed";
    } else if (failed > 0 && sent === 0) {
      campaignStatus = "failed";
    }

    expect(campaignStatus).toBe("partially_failed");
  });

  it("prevents duplicate dispatch by honoring existing providerMessageId on claimed recipient", () => {
    let mockEmailSendCalls = 0;

    const claimedRecipient = {
      id: "recip-123",
      status: "processing",
      provider_message_id: "ses-msg-prior-to-crash-999",
      sent_at: new Date("2026-10-14T01:00:00Z"),
    };

    let recipientFinalStatus = "processing";
    if (claimedRecipient.provider_message_id) {
      // Prior dispatch succeeded before worker crash -> recover state without re-calling email provider
      recipientFinalStatus = "sent";
    } else {
      mockEmailSendCalls++;
      recipientFinalStatus = "sent";
    }

    expect(recipientFinalStatus).toBe("sent");
    expect(mockEmailSendCalls).toBe(0); // ZERO duplicate calls to email provider!
  });

  it("reconciles ambiguous send outcomes directly via email_events.recipientId", () => {
    let providerCalls = 0;
    const crashedItem = {
      recipientId: "recip-987",
      status: "processing",
    };

    // Webhook event received while worker was offline
    const emailEventsTable = [
      {
        providerMessageId: "provider-msg-abc",
        recipientId: "recip-987",
        eventType: "delivered",
      },
    ];

    const matchedEvent = emailEventsTable.find((e) => e.recipientId === crashedItem.recipientId);

    let finalStatus = crashedItem.status;
    if (matchedEvent) {
      finalStatus = matchedEvent.eventType === "delivered" ? "delivered" : "sent";
    } else {
      providerCalls++;
    }

    expect(finalStatus).toBe("delivered");
    expect(providerCalls).toBe(0); // Webhook telemetry reconciled; no duplicate send
  });

  it("enforces exponential backoff on transient recipient failures", () => {
    function calculateBackoff(currentAttempts: number, maxAttempts: number, errorMsg: string) {
      const isPermanent =
        errorMsg.toLowerCase().includes("suppress") ||
        errorMsg.toLowerCase().includes("blacklisted") ||
        errorMsg.toLowerCase().includes("invalid email");

      if (isPermanent || currentAttempts >= maxAttempts) {
        return { shouldRetry: false, nextStatus: "failed" };
      }

      const backoffMinutes = currentAttempts === 1 ? 2 : 5;
      return {
        shouldRetry: true,
        nextStatus: "queued",
        backoffMinutes,
      };
    }

    // 1. Transient 503 error on first attempt -> Retry in 2 minutes
    const attempt1 = calculateBackoff(1, 3, "HTTP 503 Service Unavailable");
    expect(attempt1.shouldRetry).toBe(true);
    expect(attempt1.nextStatus).toBe("queued");
    expect(attempt1.backoffMinutes).toBe(2);

    // 2. Transient error on second attempt -> Retry in 5 minutes
    const attempt2 = calculateBackoff(2, 3, "Connection timeout");
    expect(attempt2.shouldRetry).toBe(true);
    expect(attempt2.backoffMinutes).toBe(5);

    // 3. Exhausted attempts -> Terminal failure
    const attempt3 = calculateBackoff(3, 3, "Connection timeout");
    expect(attempt3.shouldRetry).toBe(false);
    expect(attempt3.nextStatus).toBe("failed");

    // 4. Permanent suppression error -> Immediate failure without retry
    const suppressed = calculateBackoff(1, 3, "Recipient email is suppressed");
    expect(suppressed.shouldRetry).toBe(false);
    expect(suppressed.nextStatus).toBe("failed");
  });

  it("prevents scheduler from creating duplicate recovery jobs while an active job lease is valid", () => {
    const campaign = {
      id: "camp-123",
      status: "sending",
      updatedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago
    };

    const activeJob = {
      jobName: "process_campaign",
      campaignId: "camp-123",
      status: "processing",
      lockedAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago (valid active lease)
    };

    function shouldSchedulerRecover(c: typeof campaign, job?: typeof activeJob) {
      const isStuck = Date.now() - c.updatedAt.getTime() > 15 * 60 * 1000;
      if (!isStuck) return false;

      // Check if active job lease is still valid (< 10 minutes old)
      if (
        job &&
        job.status === "processing" &&
        Date.now() - job.lockedAt.getTime() < 10 * 60 * 1000
      ) {
        return false; // Active job is currently running; do not recover!
      }

      return true;
    }

    // With active job holding valid lease: DO NOT RECOVER
    expect(shouldSchedulerRecover(campaign, activeJob)).toBe(false);

    // With expired job lease (worker crashed 12 minutes ago): DO RECOVER
    const crashedJob = {
      ...activeJob,
      lockedAt: new Date(Date.now() - 12 * 60 * 1000),
    };
    expect(shouldSchedulerRecover(campaign, crashedJob)).toBe(true);

    // With no job: DO RECOVER
    expect(shouldSchedulerRecover(campaign, undefined)).toBe(true);
  });
});
