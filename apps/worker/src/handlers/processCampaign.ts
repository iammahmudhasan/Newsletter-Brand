import {
  db,
  campaigns,
  subscribers,
  suppressions,
  campaignRecipients,
  eq,
  and,
  notInArray,
  sql,
} from "@ai-signal/db";
import { getEmailProvider, renderNewsletterEmail } from "@ai-signal/email";
import { config, generateSignedToken } from "@ai-signal/config";

export async function handleProcessCampaignBatch(payload: { campaignId: string }) {
  const { campaignId } = payload;
  const provider = getEmailProvider();

  // 1. Fetch campaign
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));

  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  if (campaign.status === "sent" || campaign.status === "cancelled") {
    console.log(`[Worker] Campaign ${campaignId} is ${campaign.status}, skipping.`);
    return;
  }

  // Update status to sending
  await db
    .update(campaigns)
    .set({ status: "sending" })
    .where(eq(campaigns.id, campaignId));

  // 2. Fetch all suppressed emails to strictly avoid sending to them
  const suppressedList = await db.select({ email: suppressions.email }).from(suppressions);
  const suppressedEmails = suppressedList.map((s) => s.email.toLowerCase());

  // 3. Fetch active subscribers
  const activeSubscribers = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.status, "active"));

  const eligibleSubscribers = activeSubscribers.filter(
    (sub) => !suppressedEmails.includes(sub.email.toLowerCase())
  );

  console.log(
    `[Worker] Processing Campaign '${campaign.title}' for ${eligibleSubscribers.length} eligible recipients.`
  );

  let successCount = 0;
  let failCount = 0;

  // Process sequentially or in controlled batches to respect provider rate limits
  for (const subscriber of eligibleSubscribers) {
    try {
      const unsubToken = generateSignedToken({
        id: subscriber.id,
        email: subscriber.email,
        purpose: "unsubscribe",
      }, 365 * 86400);

      const unsubscribeUrl = `${config.appUrl}/unsubscribe?token=${unsubToken}`;
      const archiveUrl = `${config.appUrl}/archive/${campaign.id}`;

      const { html, text, headers } = renderNewsletterEmail({
        issueNumber: 1, // dynamically extracted or sequenced
        issueDate: new Date().toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        title: campaign.title,
        previewText: campaign.previewText || "",
        htmlContent: campaign.contentHtml,
        recipientEmail: subscriber.email,
        unsubscribeUrl,
        archiveUrl,
      });

      const sendResult = await provider.sendEmail({
        to: subscriber.email,
        subject: campaign.subject,
        html,
        text,
        headers,
      });

      if (sendResult.success) {
        successCount++;
        // Record recipient status
        await db
          .insert(campaignRecipients)
          .values({
            campaignId: campaign.id,
            subscriberId: subscriber.id,
            status: "sent",
            providerMessageId: sendResult.messageId,
            sentAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [campaignRecipients.campaignId, campaignRecipients.subscriberId],
            set: {
              status: "sent",
              providerMessageId: sendResult.messageId,
              sentAt: new Date(),
            },
          });
      } else {
        failCount++;
        await db
          .insert(campaignRecipients)
          .values({
            campaignId: campaign.id,
            subscriberId: subscriber.id,
            status: "failed",
            errorMessage: sendResult.error,
          })
          .onConflictDoUpdate({
            target: [campaignRecipients.campaignId, campaignRecipients.subscriberId],
            set: {
              status: "failed",
              errorMessage: sendResult.error,
            },
          });
      }
    } catch (err: any) {
      failCount++;
      console.error(`[Worker] Error sending to ${subscriber.email}:`, err.message);
    }
  }

  // 4. Finalize campaign
  await db
    .update(campaigns)
    .set({
      status: "sent",
      sentAt: new Date(),
      totalRecipients: eligibleSubscribers.length,
      successfulSends: successCount,
      failedSends: failCount,
    })
    .where(eq(campaigns.id, campaignId));

  console.log(
    `[Worker] Campaign '${campaign.title}' completed. Succeeded: ${successCount}, Failed: ${failCount}`
  );
}
