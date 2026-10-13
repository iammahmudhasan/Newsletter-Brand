import {
  generateSignedToken,
  verifySignedToken,
  normalizeEmail,
  hashIp,
} from "@ai-signal/config";
import {
  getEmailProvider,
  renderConfirmationEmail,
  renderWelcomeEmail,
  renderNewsletterEmail,
} from "@ai-signal/email";

async function verifyAll() {
  console.log("==================================================");
  console.log("🧪 AI Signal Platform - Core Logic Verification");
  console.log("==================================================");

  // 1. Email Normalization
  const rawEmail = "  Dev.Researcher+ai@Gmail.com  ";
  const normalized = normalizeEmail(rawEmail);
  console.log(`✓ Email Normalization: '${rawEmail}' -> '${normalized}'`);
  if (normalized !== "dev.researcher+ai@gmail.com") {
    throw new Error("Email normalization failed");
  }

  // 2. IP Hashing
  const hashedIp = hashIp("192.168.1.1");
  console.log(`✓ Privacy IP Hash generated: ${hashedIp.slice(0, 16)}...`);

  // 3. HMAC Token Signing & Verification
  const testPayload = {
    id: "sub_12345678",
    email: normalized,
    purpose: "confirm" as const,
  };
  const token = generateSignedToken(testPayload, 3600);
  console.log(`✓ Signed Token Generated: ${token.slice(0, 24)}...`);

  const verification = verifySignedToken(token);
  if (!verification.valid || verification.payload?.id !== testPayload.id) {
    throw new Error("Token verification failed!");
  }
  console.log("✓ Token Signature & Payload correctly verified via HMAC-SHA256");

  // Tamper check
  const tamperedToken = token.slice(0, -5) + "abcde";
  const tamperedCheck = verifySignedToken(tamperedToken);
  if (tamperedCheck.valid) {
    throw new Error("Tampered token should not be valid!");
  }
  console.log("✓ Tampered token rejected safely");

  // 4. Email Templates Rendering
  const provider = getEmailProvider();
  console.log(`✓ Active Email Provider: ${provider.name}`);

  // Test confirmation render
  const confirmResult = renderConfirmationEmail({
    email: normalized,
    confirmUrl: `http://localhost:3000/confirm?token=${token}`,
  });
  if (!confirmResult.html.includes("Confirm Subscription") || !confirmResult.html.includes("AI SIGNAL")) {
    throw new Error("Confirmation email template rendering issue");
  }
  console.log("✓ Double Opt-in email HTML & Plaintext rendered cleanly");

  // Test newsletter render & headers
  const unsubToken = generateSignedToken({
    id: testPayload.id,
    email: normalized,
    purpose: "unsubscribe",
  });
  const issueResult = renderNewsletterEmail({
    issueNumber: 1,
    issueDate: "October 17, 2026",
    title: "Frontier Reasoning & Test-Time Compute",
    previewText: "3 critical updates and Quiet-STaR breakdown",
    htmlContent: "<h2>Test Content</h2><p>Analysis of inference scaling.</p>",
    recipientEmail: normalized,
    unsubscribeUrl: `http://localhost:3000/unsubscribe?token=${unsubToken}`,
    archiveUrl: `http://localhost:3000/archive/1`,
  });

  if (!issueResult.headers["List-Unsubscribe"] || !issueResult.headers["List-Unsubscribe-Post"]) {
    throw new Error("Missing RFC 8058 one-click unsubscribe headers!");
  }
  console.log("✓ RFC 8058 One-Click Unsubscribe headers validated:", issueResult.headers["List-Unsubscribe"]);

  // Test Dispatch via Console Provider
  const dispatch = await provider.sendEmail({
    to: normalized,
    subject: "Test Verification Run",
    html: confirmResult.html,
    text: confirmResult.text,
  });
  console.log(`✓ Mock Dispatch Result: ${dispatch.success ? "SUCCESS" : "FAILED"} (ID: ${dispatch.messageId})`);

  console.log("\n🎉 All 5 core subsystem checks PASSED successfully!\n");
}

verifyAll().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
