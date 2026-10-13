import fs from "fs";
import path from "path";
import crypto from "crypto";
import { EmailProvider, SendEmailOptions, SendEmailResult } from "../types";

export class ConsoleMockEmailProvider implements EmailProvider {
  name = "console" as const;

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const messageId = `mock_${crypto.randomUUID()}`;
    const to = Array.isArray(options.to) ? options.to.join(", ") : options.to;

    // Extract clickable links from HTML for quick dev convenience
    const linkRegex = /href=["'](https?:\/\/[^"']+)["']/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(options.html)) !== null) {
      if (!links.includes(match[1])) {
        links.push(match[1]);
      }
    }

    console.log("\n=======================================================");
    console.log(`✉️ [MOCK EMAIL DISPATCHED] ID: ${messageId}`);
    console.log(`To:      ${to}`);
    console.log(`From:    ${options.from || "AI Signal <newsletter@aisignal.dev>"}`);
    console.log(`Subject: ${options.subject}`);
    if (links.length > 0) {
      console.log(`\n🔗 Action Links extracted:`);
      links.forEach((l) => console.log(`   👉 ${l}`));
    }
    console.log("=======================================================\n");

    // Save to local debug folder
    try {
      const emailDir = path.resolve(process.cwd(), ".local_emails");
      if (!fs.existsSync(emailDir)) {
        fs.mkdirSync(emailDir, { recursive: true });
      }
      const safeTo = to.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `${Date.now()}_${safeTo}.html`;
      const filePath = path.join(emailDir, filename);
      fs.writeFileSync(filePath, options.html, "utf-8");
      console.log(`💾 Saved email preview to: ${filePath}`);
    } catch {
      // Ignore file write errors in restricted environments
    }

    return {
      success: true,
      messageId,
      provider: "console",
    };
  }
}
