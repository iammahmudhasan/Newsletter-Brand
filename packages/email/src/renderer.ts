export interface RenderEmailOptions {
  subject: string;
  previewText?: string;
  bodyHtml: string;
  unsubscribeUrl?: string;
  archiveUrl?: string;
}

/**
 * Strips HTML tags to generate a clean plain-text fallback
 */
export function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Injects preheader text with zero-width whitespace to hide preview snippet leaks
 */
export function injectPreheader(previewText: string): string {
  if (!previewText) return "";
  const filler = "&#847; &zwnj; &nbsp; &zwnj; &nbsp; ".repeat(10);
  return `
    <div style="display: none; max-height: 0px; overflow: hidden; mso-hide: all;">
      ${previewText} ${filler}
    </div>
  `.trim();
}

/**
 * Universal email layout renderer for brand consistency
 */
export function renderEmailLayout(options: RenderEmailOptions): {
  html: string;
  text: string;
} {
  const { subject, previewText = "", bodyHtml, unsubscribeUrl, archiveUrl } = options;

  const preheaderHtml = injectPreheader(previewText);
  const plainText = stripHtmlToPlainText(bodyHtml);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #08090e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e2e8f0;">
  ${preheaderHtml}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #08090e; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background: #0f121b; border: 1px solid #1e2538; border-radius: 16px; overflow: hidden;">
          <tr>
            <td style="padding: 32px;">
              ${bodyHtml}
            </td>
          </tr>
          ${
            unsubscribeUrl
              ? `
          <tr>
            <td style="padding: 24px 32px; background: #0b0d13; text-align: center; border-top: 1px solid #1e2538; font-size: 12px; color: #64748b;">
              <p style="margin: 0 0 8px;">
                <a href="${unsubscribeUrl}" style="color: #94a3b8; text-decoration: underline;">Unsubscribe</a>
                ${archiveUrl ? ` · <a href="${archiveUrl}" style="color: #94a3b8; text-decoration: underline;">Web Archive</a>` : ""}
              </p>
              <p style="margin: 0; font-size: 11px; color: #475569;">
                AI Signal Media · Strict Double Opt-In Verification
              </p>
            </td>
          </tr>
          `
              : ""
          }
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return { html, text: plainText };
}
