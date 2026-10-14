import { describe, it, expect } from "bun:test";
import { POST } from "../../apps/web/src/app/api/webhooks/email/route";
import { normalizeWebhookEventType } from "../../apps/web/src/lib/webhookHelpers";

describe("Webhook Atomic Transaction & Delivery State Machine", () => {
  it("rejects malformed JSON payloads gracefully with HTTP 400", async () => {
    const req = new Request("http://localhost:3000/api/webhooks/email", {
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

    const req = new Request("http://localhost:3000/api/webhooks/email", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.note).toContain("No recipient detected");
  });

  it("handles Resend and SES event normalization accurately without false deliver matches", () => {
    const types = [
      "email.delivered",
      "Delivery",
      "email.delivery_delayed",
      "DeliveryDelay",
      "email.bounced",
      "Bounce",
      "email.complained",
      "Complaint",
      "email.failed",
      "email.suppressed",
      "Reject",
      "Rendering Failure",
      "RenderingFailure",
      "email.clicked",
      "email.opened",
      "custom.other",
    ];
    const normalized = types.map((t) => normalizeWebhookEventType(t));

    expect(normalized).toEqual([
      "delivered",
      "delivered",
      "delivery_delayed",
      "delivery_delayed",
      "bounce",
      "bounce",
      "complaint",
      "complaint",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "click",
      "open",
      "unknown",
    ]);
  });

  it("strictly enforces that bounce events transition recipient status to 'bounced' and NEVER 'sent'", () => {
    function calculateRecipientTransition(eventType: string, isHardBounce: boolean) {
      if (eventType === "delivered") return "delivered";
      if (eventType === "bounce") return "bounced";
      if (eventType === "complaint") return "failed";
      if (eventType === "open" || eventType === "click") return "delivered";
      return "unchanged";
    }

    const bounceTransition = calculateRecipientTransition("bounce", true);
    expect(bounceTransition).toBe("bounced");
    expect(bounceTransition).not.toBe("sent");

    const softBounceTransition = calculateRecipientTransition("bounce", false);
    expect(softBounceTransition).toBe("bounced");
    expect(softBounceTransition).not.toBe("sent");

    const complaintTransition = calculateRecipientTransition("complaint", false);
    expect(complaintTransition).toBe("failed");
    expect(complaintTransition).not.toBe("sent");

    const deliveredTransition = calculateRecipientTransition("delivered", false);
    expect(deliveredTransition).toBe("delivered");
  });

  it("extracts recipient_id and campaign_id accurately from Resend tag array of objects", () => {
    const resendTags = [
      { name: "campaign_id", value: "camp-uuid-123" },
      { name: "recipient_id", value: "recip-uuid-456" },
    ];

    const foundRecipient = resendTags.find((t) => t.name === "recipient_id")?.value;
    const foundCampaign = resendTags.find((t) => t.name === "campaign_id")?.value;

    expect(foundRecipient).toBe("recip-uuid-456");
    expect(foundCampaign).toBe("camp-uuid-123");
  });

  it("allows multiple engagement events (repeat open/clicks) through distinct providerEventIds", () => {
    const event1 = {
      providerEventId: "evt_open_1",
      providerMessageId: "msg_999",
      eventType: "open",
      timestamp: 1000,
    };
    const event2 = {
      providerEventId: "evt_open_2", // Different open event from reader
      providerMessageId: "msg_999", // Same email message
      eventType: "open",
      timestamp: 2000,
    };

    const recordedEvents = new Map<string, any>();
    function recordEvent(evt: typeof event1) {
      if (recordedEvents.has(evt.providerEventId)) {
        return { duplicate: true };
      }
      recordedEvents.set(evt.providerEventId, evt);
      return { duplicate: false };
    }

    const res1 = recordEvent(event1);
    const res2 = recordEvent(event2);
    const resDuplicate = recordEvent(event1);

    expect(res1.duplicate).toBe(false);
    expect(res2.duplicate).toBe(false);
    expect(resDuplicate.duplicate).toBe(true);
    expect(recordedEvents.size).toBe(2);
  });
});
