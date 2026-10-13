import crypto from "crypto";

export const config = {
  appUrl: process.env.APP_URL || "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ai_signal",
  authSecret: process.env.AUTH_SECRET || "fallback-secret-development-only-change-me",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  email: {
    provider: (process.env.EMAIL_PROVIDER || "console") as "console" | "resend" | "ses",
    fromName: process.env.EMAIL_FROM_NAME || "AI Signal",
    fromAddress: process.env.EMAIL_FROM_ADDRESS || "newsletter@aisignal.dev",
    replyTo: process.env.EMAIL_REPLY_TO || "curator@aisignal.dev",
    resendApiKey: process.env.RESEND_API_KEY || "",
    aws: {
      region: process.env.AWS_REGION || "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
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

export interface TokenPayload {
  id: string;
  email: string;
  purpose: "confirm" | "unsubscribe";
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
 * Verifies and decodes a signed token
 */
export function verifySignedToken(token: string): {
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

    if (
      !crypto.timingSafeEqual(
        Buffer.from(providedSig),
        Buffer.from(expectedSig)
      )
    ) {
      return { valid: false, error: "Invalid signature" };
    }

    const jsonStr = Buffer.from(base64Data, "base64url").toString("utf-8");
    const payload = JSON.parse(jsonStr) as TokenPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: "Token expired" };
    }

    return { valid: true, payload };
  } catch (err: any) {
    return { valid: false, error: err?.message || "Failed to parse token" };
  }
}
