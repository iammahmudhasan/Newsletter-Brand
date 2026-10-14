import { db, subscribers, suppressions, eq } from "@ai-signal/db";
import { getEmailProvider, renderWelcomeEmail } from "@ai-signal/email";
import { config, generateSignedToken, normalizeEmail } from "@ai-signal/config";

export async function handleSendWelcome(payload: { subscriberId: string; email: string }) {
  const { subscriberId, email } = payload;
  const normalizedEmail = normalizeEmail(email);
  const provider = getEmailProvider();

  // 1. Guard against sending to suppressed or unsubscribed addresses
  const [suppressed] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, normalizedEmail));

  if (suppressed) {
    console.warn(`[Worker SendWelcome] Aborted: ${normalizedEmail} is currently on the suppression list.`);
    return;
  }

  // 2. Fresh check: Verify subscriber still exists in database and is active
  const [subscriber] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId));

  if (!subscriber || subscriber.status !== "active") {
    console.warn(
      `[Worker SendWelcome] Aborted: Subscriber ${subscriberId} is not in active state (currently: ${subscriber?.status || "deleted"}).`
    );
    return;
  }

  // 3. Reuse existing unsubscribe token if present, or generate a deterministic one
  let unsubToken = subscriber.unsubscribeToken;
  if (!unsubToken) {
    unsubToken = generateSignedToken(
      {
        id: subscriberId,
        email: normalizedEmail,
        purpose: "unsubscribe",
      },
      365 * 86400 // 1 year validity
    );

    await db
      .update(subscribers)
      .set({
        unsubscribeToken: unsubToken,
      })
      .where(eq(subscribers.id, subscriberId));
  }

  const unsubscribeUrl = `${config.appUrl}/unsubscribe?token=${unsubToken}`;

  const { html, text } = renderWelcomeEmail({
    email: normalizedEmail,
    unsubscribeUrl,
  });

  const idempotencyKey = `welcome:${subscriberId}`;

  const sendResult = await provider.sendEmail({
    to: normalizedEmail,
    subject: "Welcome to AI Signal — What to expect",
    html,
    text,
    idempotencyKey,
  });

  if (!sendResult.success) {
    throw new Error(`Failed to send welcome email: ${sendResult.error}`);
  }

  console.log(`[Worker] Sent welcome email to ${normalizedEmail} (MessageId: ${sendResult.messageId})`);
}

