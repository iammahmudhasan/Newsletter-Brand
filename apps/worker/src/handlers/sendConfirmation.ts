import { db, subscribers, suppressions, eq } from "@ai-signal/db";
import { getEmailProvider, renderConfirmationEmail } from "@ai-signal/email";
import { config, generateSignedToken, normalizeEmail } from "@ai-signal/config";

export async function handleSendConfirmation(payload: { subscriberId: string; email: string }) {
  const { subscriberId, email } = payload;
  const normalizedEmail = normalizeEmail(email);
  const provider = getEmailProvider();

  // 1. Guard against sending to suppressed or unsubscribed addresses
  const [suppressed] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, normalizedEmail));

  if (suppressed) {
    console.warn(`[Worker SendConfirmation] Aborted: ${normalizedEmail} is currently on the suppression list.`);
    return;
  }

  // 2. Fresh check: Verify subscriber still exists in database and is eligible
  const [subscriber] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId));

  if (!subscriber || subscriber.status !== "pending_confirmation") {
    console.warn(
      `[Worker SendConfirmation] Aborted: Subscriber ${subscriberId} is not in pending_confirmation state (currently: ${subscriber?.status || "deleted"}).`
    );
    return;
  }

  // 3. Reuse unexpired token if already present to guarantee deterministic link and idempotency
  let token = subscriber.confirmationToken;
  if (!token || !subscriber.confirmationTokenExpiresAt || subscriber.confirmationTokenExpiresAt < new Date()) {
    token = generateSignedToken(
      {
        id: subscriberId,
        email: normalizedEmail,
        purpose: "confirm",
      },
      72 * 3600
    );

    await db
      .update(subscribers)
      .set({
        confirmationToken: token,
        confirmationTokenExpiresAt: new Date(Date.now() + 72 * 3600 * 1000),
      })
      .where(eq(subscribers.id, subscriberId));
  }

  const confirmUrl = `${config.appUrl}/confirm?token=${token}`;

  const { html, text } = renderConfirmationEmail({
    email: normalizedEmail,
    confirmUrl,
  });

  const idempotencyKey = `confirm:${subscriberId}:${token}`;

  const sendResult = await provider.sendEmail({
    to: normalizedEmail,
    subject: "Confirm your AI Signal subscription",
    html,
    text,
    idempotencyKey,
  });

  if (!sendResult.success) {
    throw new Error(`Failed to dispatch confirmation email: ${sendResult.error}`);
  }

  console.log(`[Worker] Sent confirmation email to ${normalizedEmail} (MessageId: ${sendResult.messageId})`);
}

