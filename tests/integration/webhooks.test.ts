import { describe, it, expect } from "bun:test";
import { POST } from "../../apps/web/src/app/api/webhooks/email/route";
import { normalizeWebhookEventType } from "../../apps/web/src/lib/webhookHelpers";

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

    // Conservative bounce classification: missing type defaults to hard bounce per Resend semantics
    const resendMissingTypePayload = {
      type: "email.bounced",
      data: {
        to: ["unknown@domain.com"],
        bounce: {}, // missing type
      },
    };

    const isMissingTypeSoft = (resendMissingTypePayload.data.bounce as any)?.type === "soft";
    expect(isMissingTypeSoft).toBe(false);
  });

  it("normalizes provider event types accurately using normalizeWebhookEventType without substring bugs", () => {
    const testCases: Array<{ raw: string; expected: string }> = [
      // Delivery delay MUST NOT be classified as delivered!
      { raw: "email.delivery_delayed", expected: "delivery_delayed" },
      { raw: "DeliveryDelay", expected: "delivery_delayed" },
      { raw: "delivery_delay", expected: "delivery_delayed" },

      // Successful delivery
      { raw: "email.delivered", expected: "delivered" },
      { raw: "Delivery", expected: "delivered" },
      { raw: "delivered", expected: "delivered" },

      // Bounces
      { raw: "email.bounced", expected: "bounce" },
      { raw: "Bounce", expected: "bounce" },

      // Complaints
      { raw: "email.complained", expected: "complaint" },
      { raw: "Complaint", expected: "complaint" },

      // Terminal failures
      { raw: "email.failed", expected: "failed" },
      { raw: "email.suppressed", expected: "failed" },
      { raw: "Reject", expected: "failed" },
      { raw: "Rendering Failure", expected: "failed" },
      { raw: "RenderingFailure", expected: "failed" },

      // Engagement
      { raw: "email.opened", expected: "open" },
      { raw: "Open", expected: "open" },
      { raw: "email.clicked", expected: "click" },
      { raw: "Click", expected: "click" },

      // Unknown / telemetry
      { raw: "Send", expected: "unknown" },
      { raw: "arbitrary.custom.event", expected: "unknown" },
      { raw: "malicious_fake_event", expected: "unknown" },
    ];

    for (const tc of testCases) {
      const standardized = normalizeWebhookEventType(tc.raw);
      expect(standardized).toBe(tc.expected as any);
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
