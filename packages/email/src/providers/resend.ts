import { EmailProvider, SendEmailOptions, SendEmailResult } from "../types";
import { config } from "@ai-signal/config";

export class ResendEmailProvider implements EmailProvider {
  name = "resend" as const;

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const apiKey = config.email.resendApiKey;
    if (!apiKey) {
      return {
        success: false,
        messageId: "",
        provider: "resend",
        error: "RESEND_API_KEY environment variable is missing",
      };
    }

    try {
      const fetchHeaders: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (options.idempotencyKey) {
        fetchHeaders["Idempotency-Key"] = options.idempotencyKey;
      }

      const emailHeaders = {
        ...options.headers,
        ...(options.idempotencyKey ? { "X-Entity-Ref-ID": options.idempotencyKey } : {}),
      };

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify({
          from: options.from || `${config.email.fromName} <${config.email.fromAddress}>`,
          to: options.to,
          reply_to: options.replyTo || config.email.replyTo,
          subject: options.subject,
          html: options.html,
          text: options.text,
          headers: emailHeaders,
          tags: options.tags
            ? Object.entries(options.tags).map(([name, value]) => ({ name, value }))
            : undefined,
        }),
      });

      const data = (await response.json()) as any;

      if (!response.ok) {
        return {
          success: false,
          messageId: "",
          provider: "resend",
          error: data?.message || `HTTP ${response.status}: Failed to send email`,
        };
      }

      return {
        success: true,
        messageId: data.id,
        provider: "resend",
      };
    } catch (err: any) {
      return {
        success: false,
        messageId: "",
        provider: "resend",
        error: err?.message || "Network exception sending email via Resend",
      };
    }
  }
}
