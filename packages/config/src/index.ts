import crypto from "crypto";

const KNOWN_INSECURE_SECRETS = new Set([
  "fallback-secret-development-only-change-me",
  "change-me",
  "secret",
  "default",
  "123456",
  "password",
]);

const KNOWN_INSECURE_PASSWORDS = new Set([
  "admin123",
  "admin",
  "password",
  "123456",
  "root",
]);

export const ALLOWED_EMAIL_PROVIDERS = ["console", "resend", "ses"] as const;
export type EmailProviderType = (typeof ALLOWED_EMAIL_PROVIDERS)[number];

/**
 * Validates configuration against fail-closed security rules in production
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") {
    return;
  }

  // Strict: Only skip runtime secret validation during Next.js static compilation phase (next build)
  if (env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  const errors: string[] = [];

  // 1. AUTH_SECRET
  const authSecret = env.AUTH_SECRET;
  if (!authSecret) {
    errors.push("AUTH_SECRET is required in production");
  } else if (KNOWN_INSECURE_SECRETS.has(authSecret)) {
    errors.push("AUTH_SECRET cannot use insecure development placeholders");
  } else if (authSecret.length < 32) {
    errors.push(`AUTH_SECRET must be at least 32 characters (currently ${authSecret.length})`);
  }

  // 2. ADMIN_PASSWORD
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    errors.push("ADMIN_PASSWORD is required in production");
  } else if (KNOWN_INSECURE_PASSWORDS.has(adminPassword)) {
    errors.push("ADMIN_PASSWORD cannot use default or common passwords");
  } else if (adminPassword.length < 12) {
    errors.push(`ADMIN_PASSWORD must be at least 12 characters (currently ${adminPassword.length})`);
  }

  // 3. DATABASE_URL
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    errors.push("DATABASE_URL is required in production");
  } else if (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) {
    errors.push("DATABASE_URL cannot point to localhost in production");
  }

  // 4. EMAIL_PROVIDER
  const provider = env.EMAIL_PROVIDER;
  if (!provider) {
    errors.push("EMAIL_PROVIDER is required in production (must be 'resend' or 'ses')");
  } else if (provider === "console") {
    errors.push("EMAIL_PROVIDER=console is not permitted in production. Must use 'resend' or 'ses'");
  } else if (!["resend", "ses"].includes(provider)) {
    errors.push(`EMAIL_PROVIDER '${provider}' is unrecognized and invalid. Must be 'resend' or 'ses'`);
  } else if (provider === "resend" && !env.RESEND_API_KEY) {
    errors.push("RESEND_API_KEY is required when EMAIL_PROVIDER=resend in production");
  } else if (provider === "ses") {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION) {
      errors.push("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION are required for SES in production");
    }
  }

  // 5. EMAIL_WEBHOOK_SECRET
  const webhookSecret = env.EMAIL_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret === "dev-webhook-secret") {
    errors.push("A secure EMAIL_WEBHOOK_SECRET is required in production");
  }

  if (errors.length > 0) {
    throw new Error(
      `[CRITICAL CONFIG ERROR] Production startup aborted due to security validation failures:\n- ${errors.join("\n- ")}`
    );
  }
}

// Run validation immediately if loaded in production
if (process.env.NODE_ENV === "production") {
  validateProductionConfig(process.env);
}

export const config = {
  appUrl: process.env.APP_URL || "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ai_signal",
  authSecret: process.env.AUTH_SECRET || "fallback-secret-development-only-change-me",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  email: {
    provider: (process.env.EMAIL_PROVIDER || "console") as EmailProviderType,
    fromName: process.env.EMAIL_FROM_NAME || "AI Signal",
    fromAddress: process.env.EMAIL_FROM_ADDRESS || "newsletter@aisignal.dev",
    replyTo: process.env.EMAIL_REPLY_TO || "curator@aisignal.dev",
    resendApiKey: process.env.RESEND_API_KEY || "",
    aws: {
      region: process.env.AWS_REGION || "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      snsTopicArn: process.env.AWS_SNS_TOPIC_ARN || "",
    },
    webhookSecret: process.env.EMAIL_WEBHOOK_SECRET || "dev-webhook-secret",
  },
};

/**
 * Normalizes email address (lowercase and whitespace trimmed)
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Hashes an IP address using SHA-256 for privacy-preserving consent logs
 */
export function hashIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  return crypto.createHash("sha256").update(ip + config.authSecret).digest("hex").slice(0, 32);
}

export type TokenPurpose = "confirm" | "unsubscribe" | "data_export" | "data_delete";

export interface TokenPayload {
  id: string;
  email: string;
  purpose: TokenPurpose;
  exp: number; // Unix timestamp in seconds
}

/**
 * Signs a URL-safe HMAC token
 */
export function generateSignedToken(
  payload: Omit<TokenPayload, "exp">,
  expiresInSeconds: number = 86400 * 3 // 3 days default
): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const data: TokenPayload = { ...payload, exp };
  const jsonStr = JSON.stringify(data);
  const base64Data = Buffer.from(jsonStr).toString("base64url");
  const signature = crypto
    .createHmac("sha256", config.authSecret)
    .update(base64Data)
    .digest("base64url");
  return `${base64Data}.${signature}`;
}

/**
 * Verifies and decodes a signed token with purpose and expiry enforcement
 */
export function verifySignedToken(
  token: string,
  expectedPurpose?: TokenPurpose
): {
  valid: boolean;
  payload?: TokenPayload;
  error?: string;
} {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { valid: false, error: "Malformed token" };
    }
    const [base64Data, providedSig] = parts;
    const expectedSig = crypto
      .createHmac("sha256", config.authSecret)
      .update(base64Data)
      .digest("base64url");

    const providedBuffer = Buffer.from(providedSig);
    const expectedBuffer = Buffer.from(expectedSig);

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return { valid: false, error: "Invalid signature" };
    }

    const jsonStr = Buffer.from(base64Data, "base64url").toString("utf-8");
    const payload = JSON.parse(jsonStr) as TokenPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: "Token expired" };
    }

    if (expectedPurpose && payload.purpose !== expectedPurpose) {
      return {
        valid: false,
        error: `Invalid token purpose: expected '${expectedPurpose}', received '${payload.purpose}'`,
      };
    }

    return { valid: true, payload };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Failed to parse token" };
  }
}
