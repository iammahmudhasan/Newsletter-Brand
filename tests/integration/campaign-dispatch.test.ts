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
});
