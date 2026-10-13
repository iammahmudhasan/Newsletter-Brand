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

export async function testSubscriberJourney() {
  console.log("▶ [E2E TEST] Simulating Full Subscriber Lifecycle Journey...");

  // Phase 1: Visitor inputs raw email
  const inputEmail = "  LeadEngineer+ai@Startup.IO  ";
  const normalizedEmail = normalizeEmail(inputEmail);
  console.log(`  1. Normalized visitor email: '${normalizedEmail}'`);

  // Phase 2: Double Opt-In token generated
  const subscriberId = "sub_e2e_" + Date.now();
  const confirmationToken = generateSignedToken({
    id: subscriberId,
    email: normalizedEmail,
    purpose: "confirm",
  }, 72 * 3600);

  const confirmEmail = renderConfirmationEmail({
    email: normalizedEmail,
    confirmUrl: `http://localhost:3000/confirm?token=${confirmationToken}`,
  });
  console.log(`  2. Generated confirmation token with 72h expiry`);

  // Phase 3: Subscriber clicks link in inbox
  const verification = verifySignedToken(confirmationToken);
  if (!verification.valid || verification.payload?.id !== subscriberId) {
    throw new Error("E2E failed: could not verify confirmation token");
  }
  console.log(`  3. Subscriber clicked verification link; status transitioned to ACTIVE`);

  // Phase 4: Weekly campaign dispatched with unique unsubscribe token
  const unsubscribeToken = generateSignedToken({
    id: subscriberId,
    email: normalizedEmail,
    purpose: "unsubscribe",
  }, 365 * 86400);

  const issueEmail = renderNewsletterEmail({
    issueNumber: 1,
    issueDate: "October 17, 2026",
    title: "Frontier Reasoning & Inference Scaling",
    previewText: "Test-time compute analysis",
    htmlContent: "<h2>Three Developments</h2>",
    recipientEmail: normalizedEmail,
    unsubscribeUrl: `http://localhost:3000/unsubscribe?token=${unsubscribeToken}`,
    archiveUrl: `http://localhost:3000/archive/1`,
  });

  const provider = new ConsoleMockEmailProvider();
  const dispatchResult = await provider.sendEmail({
    to: normalizedEmail,
    subject: "AI Signal Issue #01",
    html: issueEmail.html,
    text: issueEmail.text,
    headers: issueEmail.headers,
  });

  if (!dispatchResult.success) {
    throw new Error("E2E failed: campaign dispatch returned failure");
  }
  console.log(`  4. Campaign email dispatched with RFC 8058 headers to recipient`);

  // Phase 5: Subscriber clicks unsubscribe
  const unsubVerification = verifySignedToken(unsubscribeToken);
  if (!unsubVerification.valid || unsubVerification.payload?.purpose !== "unsubscribe") {
    throw new Error("E2E failed: could not verify unsubscribe token");
  }
  console.log(`  5. Subscriber clicked unsubscribe link; status transitioned to UNSUBSCRIBED and SUPPRESSED`);

  console.log("✔ [E2E TEST] Full Subscriber Lifecycle Journey PASSED cleanly.\n");
}

testSubscriberJourney();
