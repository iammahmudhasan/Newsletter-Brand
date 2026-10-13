import { EmailProvider } from "./types";
import { ConsoleMockEmailProvider } from "./providers/console";
import { ResendEmailProvider } from "./providers/resend";
import { SesEmailProvider } from "./providers/ses";
import { config } from "@ai-signal/config";

export * from "./types";
export * from "./templates/confirmation";
export * from "./templates/welcome";
export * from "./templates/newsletter";

let providerInstance: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (providerInstance) return providerInstance;

  switch (config.email.provider) {
    case "resend":
      providerInstance = new ResendEmailProvider();
      break;
    case "ses":
      providerInstance = new SesEmailProvider();
      break;
    case "console":
    default:
      providerInstance = new ConsoleMockEmailProvider();
      break;
  }

  return providerInstance;
}
