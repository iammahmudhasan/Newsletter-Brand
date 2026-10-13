import { db, subscribers, eq } from "@ai-signal/db";
import { getEmailProvider, renderConfirmationEmail } from "@ai-signal/email";
import { config, generateSignedToken } from "@ai-signal/config";

export async function handleSendConfirmation(payload: { subscriberId: string; email: string }) {
  const { subscriberId, email } = payload;
  const provider = getEmailProvider();

  // Create signed token (valid for 72 hours)
  const token = generateSignedToken({
    id: subscriberId,
    email,
    purpose: "confirm",
  }, 72 * 3600);

  const confirmUrl = `${config.appUrl}/confirm?token=${token}`;

  const { html, text } = renderConfirmationEmail({
    email,
    confirmUrl,
  });

  const sendResult = await provider.sendEmail({
    to: email,
    subject: "Confirm your AI Signal subscription",
    html,
    text,
  });

  if (!sendResult.success) {
    throw new Error(`Failed to dispatch confirmation email: ${sendResult.error}`);
  }

  // Update subscriber with token for audit
  await db
    .update(subscribers)
    .set({
      confirmationToken: token,
      confirmationTokenExpiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    })
    .where(eq(subscribers.id, subscriberId));

  console.log(`[Worker] Sent confirmation email to ${email} (MessageId: ${sendResult.messageId})`);
}
