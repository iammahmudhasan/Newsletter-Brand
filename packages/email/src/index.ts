import { EmailProvider } from "./types";
import { ConsoleMockEmailProvider } from "./providers/console";
import { ResendEmailProvider } from "./providers/resend";
import { SesEmailProvider } from "./providers/ses";
import { config } from "@ai-signal/config";

export * from "./types";
export * from "./renderer";
export * from "./providers/console";
export * from "./providers/resend";
export * from "./providers/ses";
export * from "./templates/confirmation";
export * from "./templates/welcome";
export * from "./templates/newsletter";
export * from "./sanitizer";

let providerInstance: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (providerInstance) return providerInstance;

  if (process.env.NODE_ENV === "production" && config.email.provider === "console") {
    throw new Error(
      "[CRITICAL EMAIL ERROR] Console mock provider cannot be used in production. Configure EMAIL_PROVIDER=resend or EMAIL_PROVIDER=ses."
    );
  }

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
