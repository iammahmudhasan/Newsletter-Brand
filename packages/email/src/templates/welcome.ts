export interface WelcomeEmailProps {
  email: string;
  unsubscribeUrl: string;
}

export function renderWelcomeEmail({ email, unsubscribeUrl }: WelcomeEmailProps): {
  html: string;
  text: string;
} {
  const text = `
Welcome to AI Signal!

Your subscription is now active.

Here is what you can expect every Friday at 9:00 AM:
- 3 Important AI Developments (with source links & analysis)
- 1 Research Paper Explained (core methodology, results & limits)
- 1 Startup or Product Signal
- 1 Actionable Takeaway for builders

Pro-tip: Move this email from Promotions to Primary or add editorial@aisignal.dev to your contacts so you never miss an issue.

To unsubscribe at any time:
${unsubscribeUrl}

--
AI Signal Editorial Team
https://aisignal.dev
  `.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to AI Signal</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0d13; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e2e8f0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0b0d13; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 580px; background: #131722; border: 1px solid #232936; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
          <!-- Header -->
          <tr>
            <td style="padding: 36px 36px 20px; text-align: left; border-bottom: 1px solid #1e2433;">
              <span style="font-size: 20px; font-weight: 800; color: #ffffff;">AI SIGNAL</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 36px;">
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #ffffff;">
                You're in! Welcome to AI Signal.
              </h1>
              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: #94a3b8;">
                Every Friday morning, you’ll receive an actionable, 5-minute briefing designed specifically for AI engineers, founders, and technical builders.
              </p>

              <div style="background: #0d1017; border: 1px solid #1e2433; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <h3 style="margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #818cf8;">
                  Inside Every Issue:
                </h3>
                <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.8; color: #cbd5e1;">
                  <li><strong>3 Critical Developments:</strong> Verified frontier news + technical context</li>
                  <li><strong>1 Research Paper Breakdown:</strong> Methodology, findings & practical caveats</li>
                  <li><strong>1 Startup Signal:</strong> Emerging product trends & infra bets</li>
                  <li><strong>1 Actionable Takeaway:</strong> Code, architecture, or model insight to use</li>
                </ul>
              </div>

              <div style="background: rgba(99, 102, 241, 0.08); border-left: 3px solid #6366f1; padding: 14px 18px; border-radius: 4px; margin: 24px 0; font-size: 13px; color: #cbd5e1; line-height: 1.5;">
                💡 <strong>Deliverability Tip:</strong> Move this email from Promotions to your Primary tab, or hit reply with a quick "Hello" so your mail provider knows you want to receive these briefings.
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px; background: #0d1017; text-align: center; border-top: 1px solid #1e2433; font-size: 12px; color: #475569;">
              <p style="margin: 0 0 8px;">
                You are receiving this because ${email} confirmed subscription on aisignal.dev.
              </p>
              <p style="margin: 0;">
                <a href="${unsubscribeUrl}" style="color: #64748b; text-decoration: underline;">One-click Unsubscribe</a>
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
