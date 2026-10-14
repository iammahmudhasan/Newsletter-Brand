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

/**
 * Atomically checks and reserves a login attempt in a single database transaction / query.
 * Eliminates race conditions where concurrent requests could bypass the lockout threshold.
 */
async function reserveLoginAttempt(
  ipHash: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const now = Date.now();

  try {
    const result = await db.execute<typeof adminLoginAttempts.$inferSelect>(sql`
      INSERT INTO admin_login_attempts (ip_hash, attempts, locked_until, updated_at)
      VALUES (${ipHash}, 1, NULL, NOW())
      ON CONFLICT (ip_hash) DO UPDATE
      SET
        attempts = CASE
          WHEN admin_login_attempts.locked_until > NOW() THEN admin_login_attempts.attempts
          WHEN admin_login_attempts.updated_at < NOW() - INTERVAL '15 minutes' THEN 1
          ELSE admin_login_attempts.attempts + 1
        END,
        locked_until = CASE
          WHEN admin_login_attempts.locked_until > NOW() THEN admin_login_attempts.locked_until
          WHEN (CASE WHEN admin_login_attempts.updated_at < NOW() - INTERVAL '15 minutes' THEN 1 ELSE admin_login_attempts.attempts + 1 END) >= ${MAX_LOGIN_ATTEMPTS}
          THEN NOW() + INTERVAL '15 minutes'
          ELSE NULL
        END,
        updated_at = NOW()
      RETURNING attempts, locked_until;
    `);

    const record = (result as any)?.[0];
    if (record) {
      if (record.locked_until && new Date(record.locked_until).getTime() > now) {
        const retryAfter = Math.ceil((new Date(record.locked_until).getTime() - now) / 1000);
        return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
      }
      if (record.attempts > MAX_LOGIN_ATTEMPTS) {
        return { allowed: false, retryAfterSeconds: 900 };
      }
    }

    return { allowed: true };
  } catch (err: any) {
    if (process.env.NODE_ENV === "production") {
      console.error("[RateLimit Production Fail-Closed]: Database error checking rate limits:", err.message);
      return { allowed: false, retryAfterSeconds: 60 };
    }

    console.warn("[RateLimit DB Error] Falling back to memory limiter in non-production:", err.message);
    const rec = fallbackRateLimits.get(ipHash);
    if (!rec || now > rec.resetAt) {
      fallbackRateLimits.set(ipHash, { attempts: 1, resetAt: now + LOCKOUT_WINDOW_MS });
      return { allowed: true };
    }

    rec.attempts += 1;
    if (rec.attempts > MAX_LOGIN_ATTEMPTS) {
      return { allowed: false, retryAfterSeconds: Math.ceil((rec.resetAt - now) / 1000) };
    }
    return { allowed: true };
  }
}

/**
 * Clears rate limit state upon successful authentication
 */
async function resetRateLimit(ipHash: string): Promise<void> {
  try {
    await db.delete(adminLoginAttempts).where(eq(adminLoginAttempts.ipHash, ipHash));
  } catch {
    // In-memory fallback cleanup
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

    // 4. Atomic check & reservation of login attempt
    const rateLimit = await reserveLoginAttempt(ipHash);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds || 60),
          },
        }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { password } = body;

    if (!password || typeof password !== "string" || !verifyAdminPassword(password)) {
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
