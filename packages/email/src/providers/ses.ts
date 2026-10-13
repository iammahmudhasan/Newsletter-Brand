import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailProvider, SendEmailOptions, SendEmailResult } from "../types";
import { config } from "@ai-signal/config";

export class SesEmailProvider implements EmailProvider {
  name = "ses" as const;
  private client: SESv2Client | null = null;

  private getClient(): SESv2Client {
    if (!this.client) {
      const { accessKeyId, secretAccessKey, region } = config.email.aws;
      this.client = new SESv2Client({
        region: region || "us-east-1",
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }
    return this.client;
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const { accessKeyId, secretAccessKey } = config.email.aws;
    if (!accessKeyId || !secretAccessKey) {
      return {
        success: false,
        messageId: "",
        provider: "ses",
        error: "AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY environment variables are missing",
      };
    }

    try {
      const client = this.getClient();
      const from = `${config.email.fromName} <${config.email.fromAddress}>`;

      const headersToSend = {
        ...options.headers,
        ...(options.idempotencyKey ? { "X-Idempotency-Key": options.idempotencyKey } : {}),
      };

      const command = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: {
          ToAddresses: Array.isArray(options.to) ? options.to : [options.to],
        },
        ReplyToAddresses: [config.email.replyTo],
        Content: {
          Simple: {
            Subject: {
              Data: options.subject,
              Charset: "UTF-8",
            },
            Body: {
              Html: {
                Data: options.html,
                Charset: "UTF-8",
              },
              Text: {
                Data: options.text,
                Charset: "UTF-8",
              },
            },
            Headers: Object.entries(headersToSend).map(([Name, Value]) => ({
              Name,
              Value: Array.isArray(Value) ? Value.join(", ") : String(Value),
            })),
          },
        },
      });

      const response = await client.send(command);

      if (!response.MessageId) {
        return {
          success: false,
          messageId: "",
          provider: "ses",
          error: "SES SendEmail response did not contain a valid MessageId",
        };
      }

      return {
        success: true,
        messageId: response.MessageId,
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
