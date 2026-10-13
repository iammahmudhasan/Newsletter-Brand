import {
  renderNewsletterEmail,
  renderConfirmationEmail,
  renderWelcomeEmail,
} from "../packages/email/src/index";

const GMAIL_CLIPPING_LIMIT_BYTES = 102 * 1024; // 102KB

function validateEmail(name: string, html: string, text: string) {
  console.log(`\n🔍 Validating Template: [${name}]`);

  const htmlSizeBytes = Buffer.byteLength(html, "utf-8");
  const sizeKb = (htmlSizeBytes / 1024).toFixed(2);
  console.log(`   - HTML Size: ${sizeKb} KB (Limit: 102 KB)`);

  if (htmlSizeBytes > GMAIL_CLIPPING_LIMIT_BYTES) {
    throw new Error(`❌ Clipping Warning: ${name} exceeds 102KB (${sizeKb} KB) and will be clipped by Gmail!`);
  } else {
    console.log("   ✅ Size is safe from Gmail clipping.");
  }

  // Check viewport meta tag
  if (!html.includes('name="viewport"')) {
    throw new Error(`❌ Missing viewport meta tag in ${name}`);
  }
  console.log("   ✅ Mobile viewport meta tag present.");

  // Check unsubscribe or confirm link
  if (!html.toLowerCase().includes("unsubscribe") && !html.toLowerCase().includes("confirm")) {
    throw new Error(`❌ Missing required action link in ${name}`);
  }
  console.log("   ✅ Action link (Unsubscribe/Confirm) present.");

  // Check plain-text fallback
  if (!text || text.length < 50) {
    throw new Error(`❌ Plain-text version is too short or missing in ${name}`);
  }
  console.log(`   ✅ Plain-text fallback verified (${text.length} characters).`);
}

function runValidation() {
  console.log("==========================================================");
  console.log("📧 AI Signal — Email Content & Deliverability Validator");
  console.log("==========================================================");

  // 1. Validate Confirmation Email
  const confirm = renderConfirmationEmail({
    email: "test@aisignal.dev",
    confirmUrl: "https://aisignal.dev/confirm?token=sample_token",
  });
  validateEmail("Confirmation Email (Double Opt-In)", confirm.html, confirm.text);

  // 2. Validate Welcome Email
  const welcome = renderWelcomeEmail({
    email: "test@aisignal.dev",
    unsubscribeUrl: "https://aisignal.dev/unsubscribe?token=sample_token",
  });
  validateEmail("Welcome Onboarding Email", welcome.html, welcome.text);

  // 3. Validate Weekly Newsletter Email
  const newsletter = renderNewsletterEmail({
    issueNumber: 1,
    issueDate: "October 17, 2026",
    title: "Frontier Reasoning & Inference Scaling",
    previewText: "Test-time compute analysis and quiet-STaR breakdown",
    htmlContent: `
      <h2>1. Three Critical AI Developments</h2>
      <p>Analysis of test-time search vs pretraining scaling laws.</p>
      <h2>2. Research Paper: Quiet-STaR</h2>
      <p>Language models thinking quietly before generating tokens.</p>
      <h2>3. Startup Signal: MicroVM Sandboxes</h2>
      <p>Deterministic execution replaces pure vector RAG.</p>
      <h2>4. Actionable Takeaway</h2>
      <p>2-cycle compiler reflection loop implementation.</p>
    `,
    recipientEmail: "test@aisignal.dev",
    unsubscribeUrl: "https://aisignal.dev/unsubscribe?token=sample_token",
    archiveUrl: "https://aisignal.dev/archive/1",
  });
  validateEmail("Weekly Issue #01 Newsletter", newsletter.html, newsletter.text);

  console.log("\n🎉 All 3 email templates passed HTML & Plain-Text production standards!\n");
}

runValidation();
