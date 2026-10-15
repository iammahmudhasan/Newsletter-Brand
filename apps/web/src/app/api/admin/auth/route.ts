import { NextRequest, NextResponse } from "next/server";
import { db, adminLoginAttempts, eq, sql } from "@ai-signal/db";
import { config, hashIp } from "@ai-signal/config";
import {
  createAdminSessionToken,
  verifyAdminPassword,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";
import { getClientIp } from "@/lib/rateLimit";

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// In-memory fallback map for offline test environments
interface FallbackRecord {
  attempts: number;
  resetAt: number;
}
const fallbackRateLimits = new Map<string, FallbackRecord>();
let dbUnavailableUntil = 0;

/**
 * Checks if the IP address is currently locked out due to exceeding maximum failed login attempts.
 */
async function checkLoginLockout(
  ipHash: string
): Promise<{ locked: boolean; retryAfterSeconds?: number }> {
  const now = Date.now();

  if (now >= dbUnavailableUntil) {
    try {
      const [record] = await db
        .select({
          attempts: adminLoginAttempts.attempts,
          lockedUntil: adminLoginAttempts.lockedUntil,
        })
        .from(adminLoginAttempts)
        .where(eq(adminLoginAttempts.ipHash, ipHash));

      if (record?.lockedUntil && new Date(record.lockedUntil).getTime() > now) {
        const retryAfter = Math.ceil((new Date(record.lockedUntil).getTime() - now) / 1000);
        return { locked: true, retryAfterSeconds: Math.max(1, retryAfter) };
      }

      return { locked: false };
    } catch {
      dbUnavailableUntil = Date.now() + 10_000;
    }
  }

  // In-memory fallback
  const rec = fallbackRateLimits.get(ipHash);
  if (rec && rec.attempts >= MAX_LOGIN_ATTEMPTS && rec.resetAt > now) {
    return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
  }
  return { locked: false };
}

/**
 * Atomically records a failed password attempt and triggers lockout only after 5 failed attempts.
 */
async function recordFailedLoginAttempt(
  ipHash: string
): Promise<{ attempts: number; locked: boolean; retryAfterSeconds?: number }> {
  const now = Date.now();

  if (now >= dbUnavailableUntil) {
    try {
      const result = await db.execute<typeof adminLoginAttempts.$inferSelect>(sql`
      INSERT INTO admin_login_attempts (ip_hash, attempts, locked_until, updated_at)
      VALUES (${ipHash}, 1, NULL, NOW())
      ON CONFLICT (ip_hash) DO UPDATE
      SET
        attempts = CASE
          WHEN admin_login_attempts.updated_at < NOW() - INTERVAL '15 minutes' THEN 1
          ELSE admin_login_attempts.attempts + 1
        END,
        locked_until = CASE
          WHEN (CASE WHEN admin_login_attempts.updated_at < NOW() - INTERVAL '15 minutes' THEN 1 ELSE admin_login_attempts.attempts + 1 END) >= ${MAX_LOGIN_ATTEMPTS}
          THEN NOW() + INTERVAL '15 minutes'
          ELSE NULL
        END,
        updated_at = NOW()
      RETURNING attempts, locked_until;
    `);

    const record = (result as any)?.[0];
    if (record) {
      const isLocked = Boolean(record.locked_until && new Date(record.locked_until).getTime() > now);
      const retryAfter = isLocked
        ? Math.max(1, Math.ceil((new Date(record.locked_until).getTime() - now) / 1000))
        : undefined;
      return { attempts: Number(record.attempts), locked: isLocked, retryAfterSeconds: retryAfter };
    }
    } catch (err: any) {
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.warn("[RateLimit FailedAttempt DB Notice]:", err.message);
      }
    }
  }

  // Fallback: In-memory store
  const rec = fallbackRateLimits.get(ipHash);
  if (!rec || now > rec.resetAt) {
    fallbackRateLimits.set(ipHash, { attempts: 1, resetAt: now + LOCKOUT_WINDOW_MS });
    return { attempts: 1, locked: false };
  }

  rec.attempts += 1;
  const isLocked = rec.attempts >= MAX_LOGIN_ATTEMPTS;
  return {
    attempts: rec.attempts,
    locked: isLocked,
    retryAfterSeconds: isLocked ? Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) : undefined,
  };
}

/**
 * Clears failed attempt rate limit state upon successful authentication
 */
async function resetRateLimit(ipHash: string): Promise<void> {
  if (Date.now() >= dbUnavailableUntil) {
    try {
      await db.delete(adminLoginAttempts).where(eq(adminLoginAttempts.ipHash, ipHash));
    } catch {
      dbUnavailableUntil = Date.now() + 10_000;
    }
  }
  fallbackRateLimits.delete(ipHash);
}

export async function POST(req: NextRequest) {
  try {
    // 1. Request body size validation: reject payloads > 2KB
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 2048) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    // 2. CSRF / Origin validation: prevent cross-origin admin credential submission
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const appUrl = new URL(config.appUrl);
        const hostHeader = req.headers.get("host") || "";
        const hostOnly = hostHeader.split(":")[0];

        if (originUrl.hostname !== appUrl.hostname && originUrl.hostname !== hostOnly) {
          return NextResponse.json(
            { error: "Forbidden: Cross-origin authentication requests are disallowed" },
            { status: 403 }
          );
        }
      } catch {
        return NextResponse.json({ error: "Malformed origin header" }, { status: 400 });
      }
    }

    // 3. Resolve and securely hash client IP for rate limiting
    const rawIp = getClientIp(req);
    const ipHash = hashIp(rawIp);

    // 4. Lockout check: Is this IP currently locked out from previous failed attempts?
    const lockout = await checkLoginLockout(ipHash);
    if (lockout.locked) {
      return NextResponse.json(
        {
          error: `Too many failed login attempts. Please try again in ${lockout.retryAfterSeconds} seconds.`,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(lockout.retryAfterSeconds || 60),
          },
        }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { password } = body;

    if (!password || typeof password !== "string" || !verifyAdminPassword(password)) {
      // Atomically record failed password attempt
      const failed = await recordFailedLoginAttempt(ipHash);
      if (failed.locked) {
        return NextResponse.json(
          {
            error: `Too many failed login attempts. Please try again in ${failed.retryAfterSeconds} seconds.`,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(failed.retryAfterSeconds || 60),
            },
          }
        );
      }
      return NextResponse.json({ error: "Invalid admin credentials" }, { status: 401 });
    }

    // 5. Success: clear rate limit counter
    await resetRateLimit(ipHash);

    const token = createAdminSessionToken();
    const res = NextResponse.json({
      success: true,
      message: "Admin authenticated successfully",
    });

    res.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });

    return res;
  } catch (err: any) {
    return NextResponse.json({ error: "Authentication processing error" }, { status: 500 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ success: true, message: "Logged out" });
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
}
