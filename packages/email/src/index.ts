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

export function getEmailProvider(overrideProvider?: string): EmailProvider {
  const chosenProvider = overrideProvider || config.email.provider;

  if (process.env.NODE_ENV === "production" && chosenProvider === "console") {
    throw new Error(
      "[CRITICAL EMAIL ERROR] Console mock provider cannot be used in production. Configure EMAIL_PROVIDER=resend or EMAIL_PROVIDER=ses."
    );
  }

  if (providerInstance && !overrideProvider) return providerInstance;

  let instance: EmailProvider;
  switch (chosenProvider) {
    case "resend":
      instance = new ResendEmailProvider();
      break;
    case "ses":
      instance = new SesEmailProvider();
      break;
    case "console":
      if (process.env.NODE_ENV === "production") {
        throw new Error("[CRITICAL EMAIL ERROR] Console mock provider is strictly forbidden in production.");
      }
      instance = new ConsoleMockEmailProvider();
      break;
    default:
      throw new Error(
        `[CRITICAL EMAIL ERROR] Unsupported or unknown email provider: '${chosenProvider}'. Expected 'resend' or 'ses' (or 'console' in development). Mock fallback is disabled.`
      );
  }

  if (!overrideProvider) {
    providerInstance = instance;
  }
  return instance;
}
