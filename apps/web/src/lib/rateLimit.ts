import { NextRequest } from "next/server";
import { db, sql } from "@ai-signal/db";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory fallback stores for unit test suites and offline environments
const rateLimitStore = new Map<string, RateLimitEntry>();
const emailCooldownStore = new Map<string, number>();

// Clean up stale in-memory entries every 5 minutes to prevent memory leak
if (typeof setInterval !== "undefined") {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt <= now) {
        rateLimitStore.delete(key);
      }
    }
    for (const [email, expiresAt] of emailCooldownStore.entries()) {
      if (expiresAt <= now) {
        emailCooldownStore.delete(email);
      }
    }
  }, 5 * 60 * 1000);

  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

const IP_REGEX = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]{2,39}$/;

/**
 * Extracts and sanitizes the client IP address from request headers.
 * Validates against strict IPv4/IPv6 syntax to prevent header injection.
 */
export function getClientIp(req: NextRequest): string {
  // 1. Next.js / Edge Runtime client IP
  const nextIp = (req as any).ip;
  if (nextIp && typeof nextIp === "string" && nextIp.trim() && IP_REGEX.test(nextIp.trim())) {
    return nextIp.trim();
  }

  // 2. Cloudflare trusted header
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && IP_REGEX.test(cfIp)) {
    return cfIp;
  }

  // 3. X-Real-IP
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && IP_REGEX.test(realIp)) {
    return realIp;
  }

  // 4. Standard X-Forwarded-For (client is leftmost entry)
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp && IP_REGEX.test(firstIp)) {
      return firstIp;
    }
  }

  return "127.0.0.1";
}

let dbUnavailableUntil = 0;

/**
 * Distributed rate limiter with PostgreSQL atomic persistence and in-memory fallback.
 * Works across multiple serverless / multi-instance nodes concurrently.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds?: number }> {
  const now = Date.now();

  if (now >= dbUnavailableUntil) {
    try {
      const result = await db.execute<{ count: number; reset_at: Date }>(sql`
        INSERT INTO rate_limits (key, count, reset_at, updated_at)
        VALUES (${key}, 1, NOW() + (${windowSeconds} || ' seconds')::interval, NOW())
        ON CONFLICT (key) DO UPDATE
        SET
          count = CASE
            WHEN rate_limits.reset_at < NOW() THEN 1
            ELSE rate_limits.count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at < NOW() THEN NOW() + (${windowSeconds} || ' seconds')::interval
            ELSE rate_limits.reset_at
          END,
          updated_at = NOW()
        RETURNING count, reset_at;
      `);

      const row = (result as any)?.[0];
      if (row) {
        const currentCount = Number(row.count);
        const resetTime = new Date(row.reset_at).getTime();
        const retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));

        if (currentCount > maxRequests) {
          return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
        }
        return { allowed: true, remaining: Math.max(0, maxRequests - currentCount) };
      }
    } catch (err: any) {
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.warn("[RateLimit Distributed Notice] Database check failed, falling back to local memory guard:", err.message);
      }
    }
  }

  // Fallback: In-memory store
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + windowSeconds * 1000,
    });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
  }

  entry.count += 1;
  return { allowed: true, remaining: maxRequests - entry.count };
}

/**
 * Distributed per-email action cooldown (prevents rapid email bombing).
 * Enforces atomic cooldown across all worker/web instances via PostgreSQL.
 */
export async function checkEmailCooldown(
  email: string,
  cooldownSeconds: number
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const normalized = email.toLowerCase().trim();
  const cooldownKey = `email_cooldown:${normalized}`;
  const now = Date.now();

  if (now >= dbUnavailableUntil) {
    try {
      const result = await db.execute<{ count: number; reset_at: Date }>(sql`
        INSERT INTO rate_limits (key, count, reset_at, updated_at)
        VALUES (${cooldownKey}, 1, NOW() + (${cooldownSeconds} || ' seconds')::interval, NOW())
        ON CONFLICT (key) DO UPDATE
        SET
          count = CASE
            WHEN rate_limits.reset_at < NOW() THEN 1
            ELSE rate_limits.count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at < NOW() THEN NOW() + (${cooldownSeconds} || ' seconds')::interval
            ELSE rate_limits.reset_at
          END,
          updated_at = NOW()
        RETURNING count, reset_at;
      `);

      const row = (result as any)?.[0];
      if (row) {
        const currentCount = Number(row.count);
        const resetTime = new Date(row.reset_at).getTime();
        const retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));

        if (currentCount > 1) {
          return { allowed: false, retryAfterSeconds: retryAfter };
        }
        return { allowed: true };
      }
    } catch (err: any) {
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.warn("[EmailCooldown Distributed Notice] DB check failed, falling back to local memory guard:", err.message);
      }
    }
  }

  // Fallback: In-memory store
  const expiresAt = emailCooldownStore.get(normalized);
  if (expiresAt && expiresAt > now) {
    const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  emailCooldownStore.set(normalized, now + cooldownSeconds * 1000);
  return { allowed: true };
}
