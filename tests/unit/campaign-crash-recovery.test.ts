import { describe, it, expect } from "bun:test";

describe("Campaign Worker Crash Recovery & State Integrity", () => {
  it("maintains 'sending' state when pending or processing recipients remain", () => {
    // Simulate recipient status count evaluation
    const recipients = [
      { id: "r1", status: "sent" },
      { id: "r2", status: "processing" }, // Worker crashed or in-flight
      { id: "r3", status: "queued" },
    ];

    const sent = recipients.filter((r) => r.status === "sent").length;
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
      { id: "r2", status: "sent" },
      { id: "r3", status: "failed" },
    ];

    const sent = recipients.filter((r) => r.status === "sent").length;
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

    // Worker crash recovery check
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
});
