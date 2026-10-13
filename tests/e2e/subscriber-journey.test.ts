import { describe, it, expect } from "bun:test";
import {
  generateSignedToken,
  verifySignedToken,
  normalizeEmail,
} from "../../packages/config/src/index";
import {
  renderConfirmationEmail,
  renderNewsletterEmail,
  ConsoleMockEmailProvider,
} from "../../packages/email/src/index";

describe("E2E Subscriber Lifecycle Journey: Double Opt-In, Campaign & Unsubscribe", () => {
  const provider = new ConsoleMockEmailProvider();
  const inputEmail = "  LeadEngineer+ai@Startup.IO  ";
  const normalizedEmail = normalizeEmail(inputEmail);
  const subscriberId = "sub_e2e_" + Date.now();

  it("1. Normalizes visitor email on signup", () => {
    expect(normalizedEmail).toBe("leadengineer+ai@startup.io");
  });

  it("2. Dispatches double opt-in verification with purpose: confirm", () => {
    const confirmationToken = generateSignedToken(
      {
        id: subscriberId,
        email: normalizedEmail,
        purpose: "confirm",
      },
      72 * 3600
    );

    const confirmEmail = renderConfirmationEmail({
      email: normalizedEmail,
      confirmUrl: `http://localhost:3000/confirm?token=${confirmationToken}`,
    });

    expect(confirmEmail.html).toContain("Confirm Subscription");
    expect(confirmEmail.text).toContain(confirmationToken);

    const verified = verifySignedToken(confirmationToken, "confirm");
    expect(verified.valid).toBe(true);
    expect(verified.payload?.purpose).toBe("confirm");

    // Must be rejected if sent to unsubscribe or gdpr
    expect(verifySignedToken(confirmationToken, "unsubscribe").valid).toBe(false);
    expect(verifySignedToken(confirmationToken, "data_export").valid).toBe(false);
  });

  it("3. Dispatches weekly campaign with RFC 8058 one-click unsubscribe headers", async () => {
    const unsubscribeToken = generateSignedToken(
      {
        id: subscriberId,
        email: normalizedEmail,
        purpose: "unsubscribe",
      },
      365 * 86400
    );

    const issueEmail = renderNewsletterEmail({
      issueNumber: 1,
      issueDate: "October 17, 2026",
      title: "Frontier Reasoning & Inference Scaling",
      previewText: "Test-time compute analysis",
      htmlContent: "<h2>Three Developments</h2>",
      recipientEmail: normalizedEmail,
      unsubscribeApiUrl: `http://localhost:3000/api/unsubscribe?token=${unsubscribeToken}`,
      unsubscribeWebUrl: `http://localhost:3000/unsubscribe?token=${unsubscribeToken}`,
      archiveUrl: `http://localhost:3000/archive/1`,
    });

    const dispatchResult = await provider.sendEmail({
      to: normalizedEmail,
      subject: "AI Signal Issue #01",
      html: issueEmail.html,
      text: issueEmail.text,
      headers: issueEmail.headers,
    });

    expect(dispatchResult.success).toBe(true);
    expect(issueEmail.headers["List-Unsubscribe"]).toContain("/api/unsubscribe?token=");
    expect(issueEmail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(issueEmail.html).toContain("/unsubscribe?token=");
  });

  it("4. Validates purpose enforcement on GDPR export and deletion tokens", () => {
    const exportToken = generateSignedToken({
      id: subscriberId,
      email: normalizedEmail,
      purpose: "data_export",
    });

    const deleteToken = generateSignedToken({
      id: subscriberId,
      email: normalizedEmail,
      purpose: "data_delete",
    });

    expect(verifySignedToken(exportToken, "data_export").valid).toBe(true);
    expect(verifySignedToken(exportToken, "confirm").valid).toBe(false);
    expect(verifySignedToken(exportToken, "data_delete").valid).toBe(false);

    expect(verifySignedToken(deleteToken, "data_delete").valid).toBe(true);
    expect(verifySignedToken(deleteToken, "unsubscribe").valid).toBe(false);
  });
});
