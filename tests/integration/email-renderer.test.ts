import {
  renderConfirmationEmail,
  renderWelcomeEmail,
  renderNewsletterEmail,
  renderEmailLayout,
  ConsoleMockEmailProvider,
} from "../../packages/email/src/index";

export async function testEmailIntegration() {
  console.log("▶ [INTEGRATION TEST] Testing Email Templates & Provider Dispatch...");

  const provider = new ConsoleMockEmailProvider();

  // 1. Confirmation Template
  const confirm = renderConfirmationEmail({
    email: "reader@aisignal.dev",
    confirmUrl: "https://aisignal.dev/confirm?token=dummy_test_token",
  });
  if (!confirm.html.includes("Confirm Subscription") || !confirm.text.includes("dummy_test_token")) {
    throw new Error("Confirmation email template rendered invalid content");
  }

  // 2. Welcome Template
  const welcome = renderWelcomeEmail({
    email: "reader@aisignal.dev",
    unsubscribeUrl: "https://aisignal.dev/unsubscribe?token=dummy_unsub_token",
  });
  if (!welcome.html.includes("Welcome to AI Signal") || !welcome.html.includes("dummy_unsub_token")) {
    throw new Error("Welcome email template rendered invalid content");
  }

  // 3. Weekly Newsletter & RFC Headers
  const issue = renderNewsletterEmail({
    issueNumber: 1,
    issueDate: "October 17, 2026",
    title: "Frontier Reasoning & Inference Scaling",
    previewText: "Test-time compute analysis",
    htmlContent: "<h2>Three Developments</h2>",
    recipientEmail: "reader@aisignal.dev",
    unsubscribeUrl: "https://aisignal.dev/unsubscribe?token=unsub_token",
    archiveUrl: "https://aisignal.dev/archive/1",
  });

  if (!issue.headers["List-Unsubscribe"] || issue.headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click") {
    throw new Error("RFC 8058 List-Unsubscribe headers missing");
  }

  // 4. Dispatch via Mock Provider
  const result = await provider.sendEmail({
    to: "reader@aisignal.dev",
    subject: "Test Issue Dispatch",
    html: issue.html,
    text: issue.text,
    headers: issue.headers,
  });

  if (!result.success || !result.messageId.startsWith("mock_")) {
    throw new Error("Mock provider dispatch returned failure");
  }

  console.log("✔ [INTEGRATION TEST] Email Templates & Provider Dispatch PASSED.");
}

testEmailIntegration();
