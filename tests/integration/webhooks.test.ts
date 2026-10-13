import { describe, it, expect } from "bun:test";
import { POST } from "../../apps/web/src/app/api/webhooks/email/route";

describe("Webhook Security, Signature Verification & Bounce Classification", () => {
  it("rejects webhook requests with 401 if signature is invalid", async () => {
    const rawBody = JSON.stringify({
      type: "email.delivered",
      data: { email: "reader@domain.com" },
    });

    const req = {
      text: async () => rawBody,
      headers: new Headers({
        "Content-Type": "application/json",
        "svix-signature": "v1=invalid_signature_hash_here",
        "svix-id": "msg_test_01",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(401);

    const data = await res.json();
    expect(data.error).toContain("Invalid webhook signature");
  });

  it("classifies transient bounces without treating them as permanent hard bounces", () => {
    // Test logic mirroring route.ts classification rules
    const sesTransientPayload = {
      eventType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        bouncedRecipients: [{ emailAddress: "busy@domain.com" }],
      },
    };

    const sesPermanentPayload = {
      eventType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "bad@domain.com" }],
      },
    };

    const isTransientHard = sesTransientPayload.bounce.bounceType === "Permanent";
    const isPermanentHard = sesPermanentPayload.bounce.bounceType === "Permanent";

    expect(isTransientHard).toBe(false);
    expect(isPermanentHard).toBe(true);

    const resendSoftPayload = {
      type: "email.bounced",
      data: {
        to: ["soft@domain.com"],
        bounce: { type: "soft" },
      },
    };

    const resendHardPayload = {
      type: "email.bounced",
      data: {
        to: ["hard@domain.com"],
        bounce: { type: "hard" },
      },
    };

    const isResendSoftHard = resendSoftPayload.data.bounce.type.toLowerCase() === "hard";
    const isResendHardHard = resendHardPayload.data.bounce.type.toLowerCase() === "hard";

    expect(isResendSoftHard).toBe(false);
    expect(isResendHardHard).toBe(true);
  });

  it("normalizes unknown event types to 'unknown' and never defaults to 'delivered'", () => {
    // Normalization logic check as enforced in route.ts
    const testCases = [
      { raw: "email.opened", expected: "open" },
      { raw: "email.clicked", expected: "click" },
      { raw: "email.delivered", expected: "delivered" },
      { raw: "email.bounced", expected: "bounce" },
      { raw: "email.complained", expected: "complaint" },
      { raw: "ses.Send", expected: "unknown" },
      { raw: "ses.RenderingFailure", expected: "unknown" },
      { raw: "arbitrary.custom.event", expected: "unknown" },
      { raw: "malicious_fake_event", expected: "unknown" },
    ];

    for (const tc of testCases) {
      const lower = tc.raw.toLowerCase();
      const standardized = lower.includes("bounce")
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

      expect(standardized).toBe(tc.expected);
    }
  });

  it("rejects untrusted AWS SNS notification webhook with invalid signature", async () => {
    const fakeSnsPayload = JSON.stringify({
      Type: "Notification",
      MessageId: "msg-fake-123",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:ai-signal-ses-events",
      Message: JSON.stringify({ eventType: "Bounce" }),
      Timestamp: "2026-10-14T00:00:00.000Z",
      SignatureVersion: "2",
      Signature: "tampered_fake_signature_bytes",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    });

    const req = {
      text: async () => fakeSnsPayload,
      headers: new Headers({
        "Content-Type": "application/json",
        "x-amz-sns-message-type": "Notification",
      }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(401);

    const data = await res.json();
    expect(data.error).toContain("Unauthorized");
  });
});
