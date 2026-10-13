export interface SendEmailOptions {
  to: string | string[];
  from?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId: string;
  provider: "console" | "resend" | "ses";
  error?: string;
}

export interface EmailProvider {
  name: "console" | "resend" | "ses";
  sendEmail(options: SendEmailOptions): Promise<SendEmailResult>;
}
