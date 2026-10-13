import { NextRequest } from "next/server";
import { config } from "@ai-signal/config";
import crypto from "crypto";

const SESSION_COOKIE_NAME = "ai_signal_admin_session";
const SESSION_MAX_AGE_SECONDS = 86400 * 7; // 7 days

/**
 * Creates a cryptographically signed admin session token with timestamp
 */
export function createAdminSessionToken(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `admin:${timestamp}`;
  const signature = crypto
    .createHmac("sha256", config.authSecret)
    .update(data)
    .digest("base64url");
  return `${Buffer.from(data).toString("base64url")}.${signature}`;
}

/**
 * Verifies that an admin session token is valid, cryptographically un-tampered, and unexpired
 */
export function verifyAdminSessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const [base64Data, signature] = parts;
    const expectedSig = crypto
      .createHmac("sha256", config.authSecret)
      .update(Buffer.from(base64Data, "base64url").toString("utf-8"))
      .digest("base64url");

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return false;
    }

    const decoded = Buffer.from(base64Data, "base64url").toString("utf-8");
    const [role, timestampStr] = decoded.split(":");
    const timestamp = parseInt(timestampStr, 10);

    const now = Math.floor(Date.now() / 1000);
    if (now - timestamp > SESSION_MAX_AGE_SECONDS) {
      return false; // Expired
    }

    return role === "admin";
  } catch {
    return false;
  }
}

/**
 * Timing-safe password verification
 */
export function verifyAdminPassword(passwordAttempt: string): boolean {
  if (!passwordAttempt || !config.adminPassword) return false;

  const attemptHash = crypto.createHash("sha256").update(passwordAttempt).digest();
  const actualHash = crypto.createHash("sha256").update(config.adminPassword).digest();

  return crypto.timingSafeEqual(attemptHash, actualHash);
}

/**
 * Enforces admin authorization strictly via signed session token (Cookie or Bearer).
 * Raw passwords are NEVER accepted as bearer tokens.
 */
export function isAuthorizedAdmin(req: NextRequest): boolean {
  // 1. Check Bearer token header (must be a valid signed session token)
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.replace("Bearer ", "").trim();
    if (verifyAdminSessionToken(bearer)) {
      return true;
    }
  }

  // 2. Check HTTP-only session cookie
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  if (cookie?.value && verifyAdminSessionToken(cookie.value)) {
    return true;
  }

  return false;
}

export { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS };
