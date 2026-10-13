import { NextRequest, NextResponse } from "next/server";
import { db, adminLoginAttempts, eq, sql } from "@ai-signal/db";
import { config, hashIp } from "@ai-signal/config";
import {
  createAdminSessionToken,
  verifyAdminPassword,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// In-memory fallback map for offline test environments
interface FallbackRecord {
  attempts: number;
  resetAt: number;
}
const fallbackRateLimits = new Map<string, FallbackRecord>();

/**
 * Extracts verified client IP address from trusted headers or fallback
 */
function getClientIp(req: NextRequest): string {
  // 1. Next.js / Edge runtime trusted client IP
  const nextIp = (req as any).ip;
  if (nextIp && typeof nextIp === "string") return nextIp.trim();

  // 2. Cloudflare trusted client IP
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  // 3. X-Real-IP from trusted reverse proxy
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  // 4. Standard X-Forwarded-For (client is leftmost entry)
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return "127.0.0.1";
}

/**
 * Checks login rate limit using PostgreSQL for distributed environments with fail-closed production policy
 */
async function checkDistributedRateLimit(
  ipHash: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const now = Date.now();

  try {
    const [record] = await db
      .select()
      .from(adminLoginAttempts)
      .where(eq(adminLoginAttempts.ipHash, ipHash));

    if (record) {
      if (record.lockedUntil && record.lockedUntil.getTime() > now) {
        const retryAfter = Math.ceil((record.lockedUntil.getTime() - now) / 1000);
        return { allowed: false, retryAfterSeconds: retryAfter };
      }

      if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
        const windowExpires = record.updatedAt.getTime() + LOCKOUT_WINDOW_MS;
        if (now < windowExpires) {
          const retryAfter = Math.ceil((windowExpires - now) / 1000);
          return { allowed: false, retryAfterSeconds: retryAfter };
        }
      }
    }

    return { allowed: true };
  } catch (err: any) {
    if (process.env.NODE_ENV === "production") {
      console.error("[RateLimit Production Fail-Closed]: Database error checking rate limits:", err.message);
      // In production, fail-closed to prevent brute force bypass during database outage
      return { allowed: false, retryAfterSeconds: 60 };
    }

    console.warn("[RateLimit DB Error] Falling back to memory limiter in non-production:", err.message);
    const rec = fallbackRateLimits.get(ipHash);
    if (rec && now < rec.resetAt && rec.attempts >= MAX_LOGIN_ATTEMPTS) {
      return { allowed: false, retryAfterSeconds: Math.ceil((rec.resetAt - now) / 1000) };
    }
    return { allowed: true };
  }
}

/**
 * Records a failed login attempt in PostgreSQL atomically using ON CONFLICT DO UPDATE
 * Completely prevents race conditions across concurrent requests.
 */
async function recordFailedAttempt(ipHash: string): Promise<void> {
  try {
    await db.execute(sql`
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
        updated_at = NOW();
    `);
  } catch (err: any) {
    if (process.env.NODE_ENV === "production") {
      console.error("[RateLimit Production Error] Failed to atomically record failed attempt in database:", err.message);
    }
    const rec = fallbackRateLimits.get(ipHash);
    const nowMs = Date.now();
    if (!rec || nowMs > rec.resetAt) {
      fallbackRateLimits.set(ipHash, { attempts: 1, resetAt: nowMs + LOCKOUT_WINDOW_MS });
    } else {
      rec.attempts += 1;
    }
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

    // 4. Distributed rate limiting check
    const rateLimit = await checkDistributedRateLimit(ipHash);
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
      await recordFailedAttempt(ipHash);
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
