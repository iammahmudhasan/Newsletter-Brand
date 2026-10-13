import { db, subscribers, eq } from "@ai-signal/db";
import { getEmailProvider, renderWelcomeEmail } from "@ai-signal/email";
import { config, generateSignedToken } from "@ai-signal/config";

export async function handleSendWelcome(payload: { subscriberId: string; email: string }) {
  const { subscriberId, email } = payload;
  const provider = getEmailProvider();

  // Generate safe unsubscribe token
  const unsubToken = generateSignedToken({
    id: subscriberId,
    email,
    purpose: "unsubscribe",
  }, 365 * 86400); // 1 year validity

  const unsubscribeUrl = `${config.appUrl}/unsubscribe?token=${unsubToken}`;

  const { html, text } = renderWelcomeEmail({
    email,
    unsubscribeUrl,
  });

  const sendResult = await provider.sendEmail({
    to: email,
    subject: "Welcome to AI Signal — What to expect",
    html,
    text,
  });

  if (!sendResult.success) {
    throw new Error(`Failed to send welcome email: ${sendResult.error}`);
  }

  // Save unsubscribe token
  await db
    .update(subscribers)
    .set({
      unsubscribeToken: unsubToken,
    })
    .where(eq(subscribers.id, subscriberId));

  console.log(`[Worker] Sent welcome email to ${email} (MessageId: ${sendResult.messageId})`);
}
