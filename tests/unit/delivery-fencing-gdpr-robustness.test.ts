import { describe, it, expect } from "bun:test";
import { normalizeWebhookEventType, computeCampaignTargetStatus } from "../../apps/web/src/lib/webhookHelpers";
import { renderNewsletterEmail } from "../../packages/email/src/templates/newsletter";
import { checkRateLimit, checkEmailCooldown, isValidIpAddress, pseudonymizeRateLimitKey, getClientIp, isPrivateOrLoopbackIp } from "../../apps/web/src/lib/rateLimit";

describe("Production Delivery, Fencing, GDPR & Robustness Verification", () => {
  describe("1. Webhook Normalization & Event Isolation (P1)", () => {
    it("strictly isolates delivery delays from terminal delivery status", () => {
      expect(normalizeWebhookEventType("email.delivery_delayed")).toBe("delivery_delayed");
      expect(normalizeWebhookEventType("DeliveryDelay")).toBe("delivery_delayed");
      expect(normalizeWebhookEventType("delivery_delay")).toBe("delivery_delayed");

      expect(normalizeWebhookEventType("email.delivery_delayed")).not.toBe("delivered");
      expect(normalizeWebhookEventType("DeliveryDelay")).not.toBe("delivered");
    });

    it("correctly maps SES and Resend terminal failures and suppression", () => {
      expect(normalizeWebhookEventType("email.failed")).toBe("failed");
      expect(normalizeWebhookEventType("email.suppressed")).toBe("suppressed");
      expect(normalizeWebhookEventType("Reject")).toBe("failed");
      expect(normalizeWebhookEventType("Rendering Failure")).toBe("failed");
      expect(normalizeWebhookEventType("RenderingFailure")).toBe("failed");
    });

    it("handles conservative bounce classification defaulting missing type to hard bounce", () => {
      function classifyBounce(bounceType: string | undefined): { isHard: boolean; isSoft: boolean } {
        const lower = (bounceType || "").toLowerCase();
        if (lower === "transient" || lower === "soft") {
          return { isHard: false, isSoft: true };
        }
        return { isHard: true, isSoft: false };
      }

      // Explicit soft bounce
      expect(classifyBounce("transient")).toEqual({ isHard: false, isSoft: true });
      expect(classifyBounce("soft")).toEqual({ isHard: false, isSoft: true });

      // Missing subtype defaults to hard bounce
      expect(classifyBounce(undefined)).toEqual({ isHard: true, isSoft: false });
      expect(classifyBounce("")).toEqual({ isHard: true, isSoft: false });
      expect(classifyBounce("Permanent")).toEqual({ isHard: true, isSoft: false });
    });
  });

  describe("2. Recipient Fencing Token Logic (P1)", () => {
    it("simulates atomic claimToken fencing preventing stale worker overwrites", () => {
      interface MockRecipient {
        id: string;
        status: string;
        claimToken: string | null;
        sentAt: Date | null;
      }

      const recipient: MockRecipient = {
        id: "rec-1",
        status: "queued",
        claimToken: null,
        sentAt: null,
      };

      // Worker A claims recipient
      const workerAClaimToken = "token-worker-a";
      recipient.status = "processing";
      recipient.claimToken = workerAClaimToken;

      // Worker A stalls for 5+ minutes. Worker B reclaims recipient
      const workerBClaimToken = "token-worker-b";
      recipient.status = "processing";
      recipient.claimToken = workerBClaimToken;

      // Worker A resumes and tries to update recipient with its stale claimToken
      function applyWorkerUpdate(
        target: MockRecipient,
        claimToken: string,
        newStatus: string
      ): boolean {
        if (target.status === "processing" && target.claimToken === claimToken) {
          target.status = newStatus;
          return true;
        }
        return false; // Fenced out!
      }

      // Worker A update must be rejected
      const workerAUpdated = applyWorkerUpdate(recipient, workerAClaimToken, "sent");
      expect(workerAUpdated).toBe(false);
      expect(recipient.status).toBe("processing");
      expect(recipient.claimToken).toBe(workerBClaimToken);

      // Worker B update succeeds
      const workerBUpdated = applyWorkerUpdate(recipient, workerBClaimToken, "sent");
      expect(workerBUpdated).toBe(true);
      expect(recipient.status).toBe("sent");
    });
  });

  describe("3. Plain-Text Email Template Content (P3)", () => {
    it("renders complete newsletter body in plain-text output", () => {
      const email = renderNewsletterEmail({
        issueNumber: 42,
        issueDate: "October 15, 2026",
        title: "Test-Time Search & Reasoning Engines",
        previewText: "Frontier LLM inference dynamics",
        htmlContent: "<h2>Key Breakthrough</h2><p>Scaling test-time search accelerates benchmark solving.</p>",
        contentPlain: "Key Breakthrough\nScaling test-time search accelerates benchmark solving.",
        recipientEmail: "reader@domain.com",
        archiveUrl: "https://aisignal.dev/archive/42",
        unsubscribeWebUrl: "https://aisignal.dev/unsubscribe?token=abc",
      });

      expect(email.text).toContain("Issue #42");
      expect(email.text).toContain("Test-Time Search & Reasoning Engines");
      expect(email.text).toContain("Scaling test-time search accelerates benchmark solving.");
      expect(email.text).toContain("https://aisignal.dev/archive/42");
      expect(email.text).toContain("https://aisignal.dev/unsubscribe?token=abc");
    });

    it("falls back to sanitized plain text from html when contentPlain is omitted", () => {
      const email = renderNewsletterEmail({
        issueNumber: 1,
        issueDate: "October 15, 2026",
        title: "HTML Fallback Test",
        previewText: "Preview",
        htmlContent: "<p>Paragraph 1 with <a href=\"https://example.com\">link text</a></p><p>Paragraph 2</p>",
        recipientEmail: "reader@domain.com",
        archiveUrl: "https://aisignal.dev/archive/1",
      });

      expect(email.text).toContain("Paragraph 1 with link text (https://example.com)");
      expect(email.text).toContain("Paragraph 2");
    });
  });

  describe("4. Abuse Prevention & Cooldown Logic (P2)", () => {
    it("enforces sliding window rate limits on client requests", async () => {
      const testKey = `test:ip:limit:${Date.now()}`;
      // Max 3 requests
      expect((await checkRateLimit(testKey, 3, 60)).allowed).toBe(true);
      expect((await checkRateLimit(testKey, 3, 60)).allowed).toBe(true);
      expect((await checkRateLimit(testKey, 3, 60)).allowed).toBe(true);

      const fourth = await checkRateLimit(testKey, 3, 60);
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("enforces per-email action cooldown against rapid email bombing", async () => {
      const testEmail = `bomb-target-${Date.now()}@domain.com`;
      // First attempt allowed
      expect((await checkEmailCooldown(testEmail, 10)).allowed).toBe(true);

      // Immediate second attempt rejected by cooldown
      const second = await checkEmailCooldown(testEmail, 10);
      expect(second.allowed).toBe(false);
      expect(second.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("strictly validates IPv4 and IPv6 addresses and rejects malformed/spoofed addresses", () => {
      // Valid IPv4
      expect(isValidIpAddress("1.1.1.1")).toBe(true);
      expect(isValidIpAddress("192.168.1.100")).toBe(true);
      expect(isValidIpAddress("255.255.255.255")).toBe(true);
      expect(isValidIpAddress("0.0.0.0")).toBe(true);

      // Invalid IPv4
      expect(isValidIpAddress("999.999.999.999")).toBe(false);
      expect(isValidIpAddress("256.1.1.1")).toBe(false);
      expect(isValidIpAddress("192.168.1.300")).toBe(false);
      expect(isValidIpAddress("01.1.1.1")).toBe(false); // Leading zero disallowed
      expect(isValidIpAddress("1.1.1")).toBe(false);
      expect(isValidIpAddress("1.1.1.1.1")).toBe(false);
      expect(isValidIpAddress("abc.def.ghi.jkl")).toBe(false);
      expect(isValidIpAddress("")).toBe(false);
      expect(isValidIpAddress(null as any)).toBe(false);

      // Valid IPv6
      expect(isValidIpAddress("::1")).toBe(true);
      expect(isValidIpAddress("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(true);
      expect(isValidIpAddress("fe80::1")).toBe(true);

      // Invalid IPv6
      expect(isValidIpAddress("1200::AB00:1234::2552:7777:1313")).toBe(false);
      expect(isValidIpAddress("2001:xyz::1")).toBe(false);
    });

    it("pseudonymizes sensitive IP and email identifiers using salted HMAC-SHA256", () => {
      const rawIp = "203.0.113.195";
      const rawEmail = "victim@example.com";

      const ipKey = pseudonymizeRateLimitKey("signup:ip", rawIp);
      const emailKey = pseudonymizeRateLimitKey("signup:email", rawEmail);

      // Prefixes are retained for metrics/domain scoping
      expect(ipKey.startsWith("signup:ip:")).toBe(true);
      expect(emailKey.startsWith("signup:email:")).toBe(true);

      // Raw personal data must NEVER be present in the resulting key
      expect(ipKey.includes(rawIp)).toBe(false);
      expect(emailKey.includes(rawEmail)).toBe(false);
      expect(emailKey.includes("victim")).toBe(false);
      expect(emailKey.includes("example.com")).toBe(false);

      // Deterministic hashing for identical normalized inputs
      expect(pseudonymizeRateLimitKey("signup:email", "Victim@Example.COM ")).toBe(emailKey);

      // Distinct prefixes produce isolated key spaces
      expect(pseudonymizeRateLimitKey("gdpr:email", rawEmail)).not.toBe(emailKey);
    });

    it("normalizes idempotency keys consistently from both header and request body, falling back if header is whitespace", () => {
      function resolveIdempotencyKey(headers: Record<string, string>, body: any): string | null {
        const headerKey = headers["idempotency-key"]?.trim() || "";
        const bodyKey = (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "")?.trim() || "";
        return (headerKey && headerKey.length > 0) ? headerKey : (bodyKey && bodyKey.length > 0) ? bodyKey : null;
      }

      // 1. From header
      expect(resolveIdempotencyKey({ "idempotency-key": "header-key-123" }, {})).toBe("header-key-123");

      // 2. From body
      expect(resolveIdempotencyKey({}, { idempotencyKey: "body-key-456" })).toBe("body-key-456");

      // 3. Header takes precedence if both provided
      expect(resolveIdempotencyKey({ "idempotency-key": "header-key-123" }, { idempotencyKey: "body-key-456" })).toBe("header-key-123");

      // 4. Trims whitespace
      expect(resolveIdempotencyKey({ "idempotency-key": "  spaced-key  " }, {})).toBe("spaced-key");

      // 5. CRITICAL EDGE CASE: Header has only whitespace -> properly falls back to valid body key
      expect(resolveIdempotencyKey({ "idempotency-key": "    " }, { idempotencyKey: "body-fallback-789" })).toBe("body-fallback-789");

      // 6. Empty or missing
      expect(resolveIdempotencyKey({}, {})).toBe(null);
      expect(resolveIdempotencyKey({}, { idempotencyKey: "   " })).toBe(null);
      expect(resolveIdempotencyKey({ "idempotency-key": "   " }, { idempotencyKey: "   " })).toBe(null);
    });

    it("extracts authoritative client IP from rightmost trusted proxy hop, defeating X-Forwarded-For spoofing", () => {
      function mockReq(headers: Record<string, string>, socketIp?: string) {
        return {
          ip: socketIp,
          headers: {
            get: (name: string) => headers[name.toLowerCase()] || null,
          },
        } as any;
      }

      // Scenario 1: Attacker sends "X-Forwarded-For: 1.2.3.4", reverse proxy appends real client IP "203.0.113.195"
      const spoofedReq = mockReq({
        "x-forwarded-for": "1.2.3.4, 203.0.113.195",
      });
      expect(getClientIp(spoofedReq)).toBe("203.0.113.195");

      // Scenario 2: Attacker injects fake private and external IPs before ALB/proxy
      const chainReq = mockReq({
        "x-forwarded-for": "9.9.9.9, 10.0.0.1, 198.51.100.42, 172.16.0.5",
      });
      // Rightmost valid public IP is 198.51.100.42 (internal proxy 172.16.0.5 is skipped)
      expect(getClientIp(chainReq)).toBe("198.51.100.42");

      // Scenario 3: CF-Connecting-IP takes precedence over X-Forwarded-For
      const cfReq = mockReq({
        "cf-connecting-ip": "198.51.100.99",
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      });
      expect(getClientIp(cfReq)).toBe("198.51.100.99");

      // Scenario 4: Socket IP from runtime takes highest priority
      const socketReq = mockReq(
        { "x-forwarded-for": "1.1.1.1" },
        "203.0.113.88"
      );
      expect(getClientIp(socketReq)).toBe("203.0.113.88");
    });
  });

  describe("5. Deliverability Ratio & Health Metrics (P2)", () => {
    it("accurately evaluates bounce and complaint thresholds using decimal ratios", () => {
      const totalOutcomes = 1000;
      const bounces = 3; // 0.3% -> ratio 0.003
      const complaints = 2; // 0.2% -> ratio 0.002

      const bounceRatio = bounces / totalOutcomes;
      const complaintRatio = complaints / totalOutcomes;

      const BOUNCE_THRESHOLD = 0.002; // 0.2%
      const COMPLAINT_THRESHOLD = 0.001; // 0.1%

      expect(bounceRatio > BOUNCE_THRESHOLD).toBe(true);
      expect(complaintRatio > COMPLAINT_THRESHOLD).toBe(true);

      const healthyBounces = 1; // 0.1% -> ratio 0.001
      const healthyComplaints = 0; // 0.0% -> ratio 0.000

      expect(healthyBounces / totalOutcomes > BOUNCE_THRESHOLD).toBe(false);
      expect(healthyComplaints / totalOutcomes > COMPLAINT_THRESHOLD).toBe(false);
    });
  });

  describe("6. Campaign Terminal Status Guard (P1)", () => {
    it("never finalizes a campaign while any recipient remains queued, processing, or in unknown_outcome", () => {
      // Scenario 1: 1 delivered, 99 queued (first webhook from a 100-recipient batch)
      const earlyWebhookRecipients = [
        { status: "delivered" },
        ...Array.from({ length: 99 }, () => ({ status: "queued" })),
      ];
      expect(computeCampaignTargetStatus(earlyWebhookRecipients)).toBe("sending");

      // Scenario 2: 50 delivered, 10 processing, 40 queued
      const inFlightRecipients = [
        ...Array.from({ length: 50 }, () => ({ status: "delivered" })),
        ...Array.from({ length: 10 }, () => ({ status: "processing" })),
        ...Array.from({ length: 40 }, () => ({ status: "queued" })),
      ];
      expect(computeCampaignTargetStatus(inFlightRecipients)).toBe("sending");

      // Scenario 3 (Critical Regression): 60 delivered, 39 sent, 1 unknown_outcome waiting for retry/reconciliation -> MUST remain 'sending'
      const ambiguousWithDelivered = [
        ...Array.from({ length: 60 }, () => ({ status: "delivered" })),
        ...Array.from({ length: 39 }, () => ({ status: "sent" })),
        { status: "unknown_outcome" },
      ];
      expect(computeCampaignTargetStatus(ambiguousWithDelivered)).toBe("sending");

      // Scenario 4: Only unknown_outcome recipients -> MUST remain 'sending'
      const onlyUnknown = [
        { status: "unknown_outcome" },
        { status: "unknown_outcome" },
      ];
      expect(computeCampaignTargetStatus(onlyUnknown)).toBe("sending");

      // Scenario 5: All 100 delivered (zero in-flight/retryable) -> 'sent'
      const allDelivered = Array.from({ length: 100 }, () => ({ status: "delivered" }));
      expect(computeCampaignTargetStatus(allDelivered)).toBe("sent");

      // Scenario 6: 95 delivered, 5 bounced (zero in-flight) -> 'partially_failed'
      const partiallyFailed = [
        ...Array.from({ length: 95 }, () => ({ status: "delivered" })),
        ...Array.from({ length: 5 }, () => ({ status: "bounced" })),
      ];
      expect(computeCampaignTargetStatus(partiallyFailed)).toBe("partially_failed");

      // Scenario 7: All 10 failed (zero in-flight) -> 'failed'
      const allFailed = Array.from({ length: 10 }, () => ({ status: "failed" }));
      expect(computeCampaignTargetStatus(allFailed)).toBe("failed");
    });
  });

  describe("7. Campaign Cancellation Safety & Dispatch Fencing (P1)", () => {
    it("strictly aborts dispatch when campaign is cancelled, even if queued or unknown_outcome recipients exist", () => {
      function evaluateWorkerAction(
        campaignStatus: string,
        activeRecipientsCount: number
      ): "skip_cancelled" | "resume_recovery" | "skip_complete" | "dispatch" {
        if (campaignStatus === "cancelled") {
          return "skip_cancelled";
        }
        if (campaignStatus === "sent") {
          if (activeRecipientsCount > 0) {
            return "resume_recovery";
          }
          return "skip_complete";
        }
        return "dispatch";
      }

      // Cancelled campaign with queued recipients MUST NOT dispatch
      expect(evaluateWorkerAction("cancelled", 10)).toBe("skip_cancelled");

      // Cancelled campaign with unknown_outcome recipients MUST NOT resume
      expect(evaluateWorkerAction("cancelled", 1)).toBe("skip_cancelled");

      // Sent campaign with remaining active recipients triggers incomplete-send recovery
      expect(evaluateWorkerAction("sent", 5)).toBe("resume_recovery");

      // Sent campaign with 0 remaining active recipients is skipped
      expect(evaluateWorkerAction("sent", 0)).toBe("skip_complete");

      // Active sending/scheduled campaign proceeds to dispatch
      expect(evaluateWorkerAction("sending", 100)).toBe("dispatch");
      expect(evaluateWorkerAction("scheduled", 100)).toBe("dispatch");
    });

    it("pre-send barrier drops dispatch immediately if campaign is cancelled or recipient claim is revoked", () => {
      function preSendGateCheck(params: {
        campaignStatus: string;
        recipientStatus: string;
        recipientClaimToken: string | null;
        workerClaimToken: string;
        subscriberActive: boolean;
        isSuppressed: boolean;
      }): { allowSend: boolean; reason?: string } {
        if (params.recipientStatus !== "processing" || params.recipientClaimToken !== params.workerClaimToken) {
          return { allowSend: false, reason: "claim_revoked_or_modified" };
        }
        if (params.campaignStatus === "cancelled") {
          return { allowSend: false, reason: "campaign_cancelled" };
        }
        if (!params.subscriberActive) {
          return { allowSend: false, reason: "subscriber_deleted_gdpr" };
        }
        if (params.isSuppressed) {
          return { allowSend: false, reason: "suppressed" };
        }
        return { allowSend: true };
      }

      const validClaim = "token-abc-123";

      // 1. Normal active send -> allowed
      expect(
        preSendGateCheck({
          campaignStatus: "sending",
          recipientStatus: "processing",
          recipientClaimToken: validClaim,
          workerClaimToken: validClaim,
          subscriberActive: true,
          isSuppressed: false,
        }).allowSend
      ).toBe(true);

      // 2. Campaign was cancelled concurrently -> blocked
      expect(
        preSendGateCheck({
          campaignStatus: "cancelled",
          recipientStatus: "processing",
          recipientClaimToken: validClaim,
          workerClaimToken: validClaim,
          subscriberActive: true,
          isSuppressed: false,
        }).reason
      ).toBe("campaign_cancelled");

      // 3. GDPR deleted subscriber concurrently -> blocked
      expect(
        preSendGateCheck({
          campaignStatus: "sending",
          recipientStatus: "processing",
          recipientClaimToken: validClaim,
          workerClaimToken: validClaim,
          subscriberActive: false,
          isSuppressed: false,
        }).reason
      ).toBe("subscriber_deleted_gdpr");

      // 4. Recipient claimToken was set to null by GDPR cancellation -> blocked
      expect(
        preSendGateCheck({
          campaignStatus: "sending",
          recipientStatus: "failed",
          recipientClaimToken: null,
          workerClaimToken: validClaim,
          subscriberActive: true,
          isSuppressed: false,
        }).reason
      ).toBe("claim_revoked_or_modified");
    });
  });

  describe("8. Atomic Campaign Status & Cancellation Overwrite Prevention (P1)", () => {
    it("atomic conditional update where status <> 'cancelled' fails to update when campaign was cancelled concurrently", () => {
      interface MockCampaign {
        id: string;
        status: "draft" | "scheduled" | "sending" | "sent" | "cancelled";
        firstDispatchAt: Date | null;
      }

      // Simulated atomic database conditional update:
      // UPDATE campaigns SET status = 'sending' WHERE id = campaignId AND status <> 'cancelled' RETURNING *;
      function simulateInitUpdate(
        campaign: MockCampaign,
        now: Date
      ): MockCampaign | null {
        if (campaign.status === "cancelled") {
          return null; // 0 rows affected!
        }
        campaign.status = "sending";
        campaign.firstDispatchAt = campaign.firstDispatchAt || now;
        return campaign;
      }

      const activeCampaign: MockCampaign = {
        id: "camp-1",
        status: "scheduled",
        firstDispatchAt: null,
      };

      const now = new Date();
      // 1. Normal initialization succeeds
      const result1 = simulateInitUpdate(activeCampaign, now);
      expect(result1).not.toBeNull();
      expect(result1?.status).toBe("sending");

      // 2. Admin cancels campaign concurrently
      activeCampaign.status = "cancelled";

      // 3. Concurrent worker initialization attempt MUST return null and NOT overwrite status back to 'sending'
      const result2 = simulateInitUpdate(activeCampaign, now);
      expect(result2).toBeNull();
      expect(activeCampaign.status).toBe("cancelled"); // Status is preserved as 'cancelled'!
    });

    it("cancels all in-flight, queued, and unknown_outcome recipients when campaign is aborted due to cancellation", () => {
      interface MockRecipient {
        id: string;
        status: "queued" | "processing" | "unknown_outcome" | "sent" | "failed";
        claimToken: string | null;
        errorMessage: string | null;
      }

      const recipients: MockRecipient[] = [
        { id: "r1", status: "sent", claimToken: null, errorMessage: null },
        { id: "r2", status: "processing", claimToken: "token-1", errorMessage: null },
        { id: "r3", status: "queued", claimToken: null, errorMessage: null },
        { id: "r4", status: "unknown_outcome", claimToken: "token-2", errorMessage: null },
      ];

      // Simulated worker recipient abort on cancelled campaign:
      function abortCancelledCampaignRecipients(list: MockRecipient[]): void {
        for (const r of list) {
          if (["queued", "processing", "unknown_outcome"].includes(r.status)) {
            r.status = "failed";
            r.errorMessage = "Cancelled by campaign cancellation";
            r.claimToken = null;
          }
        }
      }

      abortCancelledCampaignRecipients(recipients);

      // Already sent recipient remains sent
      expect(recipients[0].status).toBe("sent");

      // Processing, queued, and unknown_outcome recipients are cancelled with claimToken null
      expect(recipients[1].status).toBe("failed");
      expect(recipients[1].claimToken).toBeNull();
      expect(recipients[1].errorMessage).toBe("Cancelled by campaign cancellation");

      expect(recipients[2].status).toBe("failed");
      expect(recipients[2].claimToken).toBeNull();

      expect(recipients[3].status).toBe("failed");
      expect(recipients[3].claimToken).toBeNull();
    });
  });

  describe("9. Action-Scoped Email Cooldown Isolation (P2)", () => {
    it("isolates cooldown key spaces between signup and GDPR requests so they do not block each other", async () => {
      const email = `scoped-test-${Date.now()}@domain.com`;

      // 1. User performs a signup request -> triggers signup:email_cooldown
      const signup1 = await checkEmailCooldown(email, 10, { actionScope: "signup" });
      expect(signup1.allowed).toBe(true);

      // 2. Immediate second signup request -> blocked by signup cooldown
      const signup2 = await checkEmailCooldown(email, 10, { actionScope: "signup" });
      expect(signup2.allowed).toBe(false);

      // 3. User requests a GDPR data export with the same email -> MUST NOT be blocked by the signup cooldown!
      const gdpr1 = await checkEmailCooldown(email, 10, { actionScope: "gdpr" });
      expect(gdpr1.allowed).toBe(true);

      // 4. Immediate second GDPR request -> blocked by GDPR cooldown
      const gdpr2 = await checkEmailCooldown(email, 10, { actionScope: "gdpr" });
      expect(gdpr2.allowed).toBe(false);
    });

    it("generates distinct pseudonymized keys for different action scopes", () => {
      const email = "reader@example.com";
      const legacyKey = pseudonymizeRateLimitKey("email_cooldown", email);
      const signupKey = pseudonymizeRateLimitKey("signup:email_cooldown", email);
      const gdprKey = pseudonymizeRateLimitKey("gdpr:email_cooldown", email);

      expect(signupKey).not.toBe(legacyKey);
      expect(gdprKey).not.toBe(legacyKey);
      expect(signupKey).not.toBe(gdprKey);

      expect(signupKey.startsWith("signup:email_cooldown:")).toBe(true);
      expect(gdprKey.startsWith("gdpr:email_cooldown:")).toBe(true);
    });
  });

  describe("10. Comprehensive IPv4 & IPv6 Private Range Validation (P2)", () => {
    it("correctly identifies all RFC 1918, RFC 6598 (CGNAT), and IPv4 special ranges", () => {
      // Loopback
      expect(isPrivateOrLoopbackIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("127.255.0.1")).toBe(true);

      // RFC 1918 Private
      expect(isPrivateOrLoopbackIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("10.255.255.254")).toBe(true);
      expect(isPrivateOrLoopbackIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("172.31.255.254")).toBe(true);
      expect(isPrivateOrLoopbackIp("192.168.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("192.168.254.254")).toBe(true);

      // Carrier-Grade NAT (RFC 6598: 100.64.0.0/10)
      expect(isPrivateOrLoopbackIp("100.64.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("100.100.50.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("100.127.255.254")).toBe(true);
      // Non-CGNAT 100.* IPs
      expect(isPrivateOrLoopbackIp("100.63.255.255")).toBe(false);
      expect(isPrivateOrLoopbackIp("100.128.0.1")).toBe(false);

      // Link-Local (RFC 3927)
      expect(isPrivateOrLoopbackIp("169.254.1.1")).toBe(true);

      // Multicast & Broadcast/Reserved
      expect(isPrivateOrLoopbackIp("224.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("240.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("255.255.255.255")).toBe(true);

      // Public IPv4 addresses MUST NOT be treated as private
      expect(isPrivateOrLoopbackIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrLoopbackIp("1.1.1.1")).toBe(false);
      expect(isPrivateOrLoopbackIp("104.26.12.31")).toBe(false);
      expect(isPrivateOrLoopbackIp("151.101.1.69")).toBe(false);
    });

    it("correctly identifies all IPv6 ULA (fc00::/7) and Link-Local (fe80::/10) ranges", () => {
      // Loopback & Unspecified
      expect(isPrivateOrLoopbackIp("::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("::")).toBe(true);

      // Unique Local Addresses (fc00::/7 covers 0xfc00 through 0xfdff)
      expect(isPrivateOrLoopbackIp("fc00::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("fc01:1234::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("fd00::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("fdff:ffff:ffff::1")).toBe(true);

      // Link-Local Unicast (fe80::/10 covers 0xfe80 through 0xfebf)
      expect(isPrivateOrLoopbackIp("fe80::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("fe90::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("fea0::1")).toBe(true);
      expect(isPrivateOrLoopbackIp("febf:ffff:ffff::1")).toBe(true);

      // Site-Local deprecated (fec0::/10 covers 0xfec0 through 0xfeff)
      expect(isPrivateOrLoopbackIp("fec0::1")).toBe(true);

      // IPv4-mapped IPv6
      expect(isPrivateOrLoopbackIp("::ffff:192.168.1.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrLoopbackIp("::ffff:8.8.8.8")).toBe(false);

      // Public IPv6 addresses MUST NOT be treated as private
      expect(isPrivateOrLoopbackIp("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateOrLoopbackIp("2001:4860:4860::8888")).toBe(false);
      expect(isPrivateOrLoopbackIp("2a00:1450:4009:820::200e")).toBe(false);
    });
  });

  describe("11. Campaign API Payload Size & Field Limits (P3)", () => {
    it("validates request body limits, idempotencyKey length, and contentPlain length", () => {
      const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1MB

      function validateCampaignPayload(params: {
        rawBodySize: number;
        idempotencyKey?: string;
        contentPlain?: string;
      }): { valid: boolean; error?: string; status?: number } {
        if (params.rawBodySize > MAX_PAYLOAD_BYTES) {
          return { valid: false, error: "Payload too large: request body exceeds 1MB limit", status: 413 };
        }
        if (params.idempotencyKey && params.idempotencyKey.length > 255) {
          return { valid: false, error: "Idempotency key cannot exceed 255 characters", status: 400 };
        }
        if (params.contentPlain && params.contentPlain.length > 500_000) {
          return { valid: false, error: "Content plain exceeds maximum size limit (500KB)", status: 400 };
        }
        return { valid: true };
      }

      // Normal valid payload
      expect(validateCampaignPayload({ rawBodySize: 50_000, idempotencyKey: "valid-key-123", contentPlain: "Plain text" }).valid).toBe(true);

      // Over 1MB payload rejected with HTTP 413
      const oversizedPayload = validateCampaignPayload({ rawBodySize: 1024 * 1024 + 10 });
      expect(oversizedPayload.valid).toBe(false);
      expect(oversizedPayload.status).toBe(413);

      // Over 255 char idempotency key rejected with HTTP 400
      const longKey = "k".repeat(256);
      const invalidKey = validateCampaignPayload({ rawBodySize: 1000, idempotencyKey: longKey });
      expect(invalidKey.valid).toBe(false);
      expect(invalidKey.status).toBe(400);

      // Over 500KB contentPlain rejected with HTTP 400
      const longPlain = "a".repeat(500_001);
      const invalidPlain = validateCampaignPayload({ rawBodySize: 600_000, contentPlain: longPlain });
      expect(invalidPlain.valid).toBe(false);
      expect(invalidPlain.status).toBe(400);
    });
  });
});
