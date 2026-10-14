export interface NewsletterIssueProps {
  issueNumber: number;
  issueDate: string;
  title: string;
  previewText: string;
  htmlContent: string;
  contentPlain?: string;
  recipientEmail: string;
  unsubscribeWebUrl?: string;
  unsubscribeApiUrl?: string;
  unsubscribeUrl?: string; // fallback
  archiveUrl: string;
}

/**
 * Strips HTML formatting into clean, accessible plain-text
 */
function htmlToPlainText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderNewsletterEmail(props: NewsletterIssueProps): {
  html: string;
  text: string;
  headers: Record<string, string>;
} {
  const {
    issueNumber,
    issueDate,
    title,
    previewText,
    htmlContent,
    contentPlain,
    recipientEmail,
    unsubscribeWebUrl,
    unsubscribeApiUrl,
    unsubscribeUrl,
    archiveUrl,
  } = props;

  // RFC 8058 standard one-click unsubscribe endpoint MUST accept POST
  const apiUrl = unsubscribeApiUrl || unsubscribeUrl || "";
  // Web page URL for user action confirmation in browser
  const webUrl = unsubscribeWebUrl || unsubscribeUrl || "";

  const headers = {
    "List-Unsubscribe": `<${apiUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "Precedence": "bulk",
    "X-Auto-Response-Suppress": "OOF, AutoReply",
  };

  const plainBody = contentPlain?.trim() || htmlToPlainText(htmlContent);

  const text = `
AI SIGNAL · Issue #${issueNumber}
${title}
Date: ${issueDate}
Archive: ${archiveUrl}

${previewText}

------------------------------------------------------------
${plainBody}

------------------------------------------------------------
Read the full interactive issue with code samples and graphics:
${archiveUrl}

To unsubscribe at any time:
${webUrl}

AI Signal Media · Strict Permission Distribution
  `.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | AI Signal #${issueNumber}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #08090d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e2e8f0;">
  <!-- Hidden Preheader -->
  <div style="display: none; max-height: 0px; overflow: hidden;">
    ${previewText} &#847; &zwnj; &nbsp; &zwnj; &nbsp; &zwnj; &nbsp;
  </div>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #08090d; padding: 32px 16px;">
    <tr>
      <td align="center">
        <!-- Main Container -->
        <table role="presentation" width="100%" style="max-width: 620px; background: #0f121b; border: 1px solid #1f2533; border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.6);">
          
          <!-- Brand Masthead -->
          <tr>
            <td style="padding: 32px 36px 24px; border-bottom: 1px solid #1a202c; background: #121622;">
              <table role="presentation" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 22px; font-weight: 900; letter-spacing: -0.5px; color: #ffffff;">AI SIGNAL</span>
                    <span style="font-size: 13px; color: #818cf8; margin-left: 8px; font-weight: 600;">#${issueNumber}</span>
                  </td>
                  <td align="right">
                    <span style="font-size: 12px; color: #64748b; font-weight: 500;">${issueDate}</span>
                  </td>
                </tr>
              </table>
              <div style="margin-top: 14px; font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; color: #94a3b8;">
                Weekly Frontier Intelligence for AI Engineers & Founders
              </div>
            </td>
          </tr>

          <!-- Issue Title Header -->
          <tr>
            <td style="padding: 32px 36px 20px;">
              <h1 style="margin: 0 0 12px; font-size: 26px; font-weight: 800; line-height: 1.3; color: #f8fafc; letter-spacing: -0.5px;">
                ${title}
              </h1>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #94a3b8;">
                ${previewText}
              </p>
            </td>
          </tr>

          <!-- Issue Main Content -->
          <tr>
            <td style="padding: 10px 36px 36px; font-size: 15px; line-height: 1.7; color: #cbd5e1;">
              ${htmlContent}
            </td>
          </tr>

          <!-- Web Version Banner -->
          <tr>
            <td style="padding: 18px 36px; background: #131722; border-top: 1px solid #1f2533; text-align: center;">
              <a href="${archiveUrl}" target="_blank" style="color: #818cf8; font-size: 13px; font-weight: 600; text-decoration: none;">
                🌐 View this issue in browser / Discussion &rarr;
              </a>
            </td>
          </tr>

          <!-- Footer with Unsubscribe -->
          <tr>
            <td style="padding: 28px 36px; background: #0b0d13; text-align: center; border-top: 1px solid #1f2533; font-size: 12px; color: #64748b; line-height: 1.6;">
              <p style="margin: 0 0 8px;">
                You received this email because you subscribed to AI Signal at <strong>${recipientEmail}</strong>.
              </p>
              <p style="margin: 0 0 8px;">
                <a href="${webUrl}" style="color: #94a3b8; text-decoration: underline;">Manage preferences / Unsubscribe</a> · 
                <a href="${archiveUrl}" style="color: #94a3b8; text-decoration: underline;">Issue Archive</a>
              </p>
              <p style="margin: 0; font-size: 11px; color: #475569;">
                AI Signal Media, Inc. · Built with provider-independent infrastructure
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

  return { html, text, headers };
}
