export interface ConfirmationEmailProps {
  email: string;
  confirmUrl: string;
}

export function renderConfirmationEmail({ email, confirmUrl }: ConfirmationEmailProps): {
  html: string;
  text: string;
} {
  const text = `
Welcome to AI Signal!

Please confirm your subscription by visiting the link below:
${confirmUrl}

This link is valid for 72 hours. If you did not sign up for AI Signal, you can safely disregard this email.

--
AI Signal Editorial Team
Actionable Intelligence for AI Engineers & Founders
  `.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm your AI Signal subscription</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0d13; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e2e8f0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0b0d13; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Container -->
        <table role="presentation" width="100%" style="max-width: 580px; background: #131722; border: 1px solid #232936; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          <!-- Brand Header -->
          <tr>
            <td style="padding: 36px 36px 20px; text-align: left; border-bottom: 1px solid #1e2433;">
              <table role="presentation" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff;">AI SIGNAL</span>
                    <span style="display: inline-block; margin-left: 8px; padding: 2px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: rgba(99, 102, 241, 0.2); color: #818cf8; border-radius: 9999px; border: 1px solid rgba(99, 102, 241, 0.4);">
                      Double Opt-In
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 36px;">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">
                Confirm your subscription
              </h1>
              <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #94a3b8;">
                You're one step away from receiving weekly, curated intelligence on frontier AI research, foundation models, and startup signals.
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 32px 0;">
                <tr>
                  <td align="left">
                    <a href="${confirmUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 10px; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);">
                      Confirm Subscription &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 24px 0 12px; font-size: 13px; color: #64748b;">
                Or copy and paste this verification URL directly into your browser:
              </p>
              <div style="background: #0d1017; border: 1px solid #1e2433; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #818cf8; word-break: break-all;">
                <a href="${confirmUrl}" style="color: #818cf8; text-decoration: underline;">${confirmUrl}</a>
              </div>

              <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #1e2433; font-size: 13px; color: #64748b; line-height: 1.5;">
                ⏰ This confirmation token will expire in <strong>72 hours</strong>.<br>
                🔒 If you did not enter your email (<code>${email}</code>) on aisignal.dev, simply ignore this message.
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px; background: #0d1017; text-align: center; border-top: 1px solid #1e2433; font-size: 12px; color: #475569;">
              <p style="margin: 0 0 8px;">
                © 2026 AI Signal. Built with custom open architecture.
              </p>
              <p style="margin: 0;">
                Strict permission-based distribution. No spam, ever.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return { html, text };
}
