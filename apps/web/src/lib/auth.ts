import { NextRequest } from "next/server";
import { config } from "@ai-signal/config";
import crypto from "crypto";

const SESSION_COOKIE_NAME = "ai_signal_admin_session";
const SESSION_MAX_AGE_SECONDS = 86400 * 7; // 7 days

export function createAdminSessionToken(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `admin:${timestamp}`;
  const signature = crypto
    .createHmac("sha256", config.authSecret)
    .update(data)
    .digest("base64url");
  return `${Buffer.from(data).toString("base64url")}.${signature}`;
}

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

    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSig)
      )
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

export function isAuthorizedAdmin(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.replace("Bearer ", "").trim();
    if (bearer === config.adminPassword) return true;
    if (verifyAdminSessionToken(bearer)) return true;
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  if (cookie?.value && verifyAdminSessionToken(cookie.value)) {
    return true;
  }

  // Allow dev access if configured
  if (process.env.NODE_ENV === "development" && !config.adminPassword) {
    return true;
  }

  return false;
}

export { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS };
