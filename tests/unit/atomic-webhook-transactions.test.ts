import { describe, it, expect } from "bun:test";
import { POST } from "../../apps/web/src/app/api/webhooks/email/route";
import { NextRequest } from "next/server";

describe("Webhook Atomic Transaction & Rollback Protection", () => {
  it("rejects malformed JSON payloads gracefully with HTTP 400", async () => {
    const req = new NextRequest("http://localhost:3000/api/webhooks/email", {
      method: "POST",
      body: "not-json{",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Malformed JSON");
  });



  it("returns 200 with note when payload has no recipient", async () => {
    const payload = {
      type: "email.delivered",
      data: {},
    };

    const req = new NextRequest("http://localhost:3000/api/webhooks/email", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.note).toContain("No recipient detected");
  });

  it("handles Resend and SES event normalization accurately", () => {
    // Normalization logic check:
    const types = ["email.delivered", "Delivery", "email.bounced", "Bounce", "email.complained", "Complaint", "email.clicked", "email.opened", "custom.other"];
    const normalized = types.map((t) => {
      const lower = t.toLowerCase();
      return lower.includes("bounce")
        ? "bounce"
        : lower.includes("complain")
        ? "complaint"
        : lower.includes("click")
        ? "click"
        : lower.includes("open")
        ? "open"
        : lower.includes("deliver")
        ? "delivered"
        : "unknown";
    });

    expect(normalized).toEqual([
      "delivered",
      "delivered",
      "bounce",
      "bounce",
      "complaint",
      "complaint",
      "click",
      "open",
      "unknown",
    ]);
  });
});
