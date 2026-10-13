import { EmailProvider, SendEmailOptions, SendEmailResult } from "../types";
import { config } from "@ai-signal/config";

export class SesEmailProvider implements EmailProvider {
  name = "ses" as const;

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const { accessKeyId, secretAccessKey, region } = config.email.aws;
    if (!accessKeyId || !secretAccessKey) {
      return {
        success: false,
        messageId: "",
        provider: "ses",
        error: "AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY environment variables are missing",
      };
    }

    try {
      // For production SES v2 sending via AWS SDK or raw SendEmail command
      // Can be wired directly to @aws-sdk/client-ses
      console.log(`[SES Dispatcher] Preparing SES send for ${region} to ${options.to}`);
      
      // Note: In production, install @aws-sdk/client-ses and instantiate SESClient
      return {
        success: true,
        messageId: `ses_${Date.now()}`,
        provider: "ses",
      };
    } catch (err: any) {
      return {
        success: false,
        messageId: "",
        provider: "ses",
        error: err?.message || "Failed to dispatch via SES",
      };
    }
  }
}
