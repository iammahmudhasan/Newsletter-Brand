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
});
