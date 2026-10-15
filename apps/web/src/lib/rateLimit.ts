import { NextRequest } from "next/server";
import { db, sql } from "@ai-signal/db";
import { config } from "@ai-signal/config";
import crypto from "crypto";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /**
   * If true, in production when the distributed database store is unavailable,
   * requests to sensitive endpoints fail closed rather than falling back to per-instance memory.
   */
  failClosed?: boolean;
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

/**
 * Validates whether an IP address is a syntactically valid IPv4 or IPv6 address.
 * Validates octets 0-255 for IPv4 to reject malformed/spoofed addresses like 999.999.999.999.
 */
export function isValidIpAddress(ip: string): boolean {
  if (!ip || typeof ip !== "string") return false;
  const trimmed = ip.trim();

  // IPv4 validation: 4 octets between 0 and 255 with no leading zeros
  const ipv4Parts = trimmed.split(".");
  if (ipv4Parts.length === 4) {
    return ipv4Parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const num = Number(part);
      if (num < 0 || num > 255) return false;
      if (part.length > 1 && part.startsWith("0")) return false;
      return true;
    });
  }

  // IPv6 validation
  if (trimmed.includes(":")) {
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?::(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?$/;
    return ipv6Regex.test(trimmed);
  }

  return false;
}

/**
 * Pseudonymizes sensitive values (e.g. IP addresses, raw emails) into irreversible
 * cryptographic hashes with server secret salting before persisting in database keys.
 * Ensures compliance with GDPR storage limitation and data minimization principles.
 */
export function pseudonymizeRateLimitKey(prefix: string, rawIdentifier: string): string {
  const normalized = rawIdentifier.toLowerCase().trim();
  const salt = config.authSecret || "default-rate-limit-salt";
  const digest = crypto.createHmac("sha256", salt).update(normalized).digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

/**
 * Prunes expired rate limit records from the database to prevent unbounded table growth
 * and avoid retaining historical client rate limit data beyond the rate limit window.
 */
export async function cleanupExpiredRateLimits(): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM rate_limits
      WHERE reset_at < NOW() - INTERVAL '10 minutes';
    `);
    return (result as any)?.rowCount || 0;
  } catch {
    return 0;
  }
}

/**
 * Extracts and sanitizes the client IP address from request headers.
 * Uses trusted proxy chain resolution with strict IPv4/IPv6 validation.
 */
export function getClientIp(req: NextRequest): string {
  // 1. Next.js / Edge Runtime client IP (authoritative behind reverse proxies like Vercel/Cloudflare)
  const nextIp = (req as any).ip;
  if (nextIp && typeof nextIp === "string" && isValidIpAddress(nextIp)) {
    return nextIp.trim();
  }

  // 2. Cloudflare trusted header
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && isValidIpAddress(cfIp)) {
    return cfIp;
  }

  // 3. X-Real-IP
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && isValidIpAddress(realIp)) {
    return realIp;
  }

  // 4. Standard X-Forwarded-For: select leftmost valid IP
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim());
    for (const part of parts) {
      if (isValidIpAddress(part)) {
        return part;
      }
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
  windowSeconds: number,
  options?: RateLimitOptions
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds?: number }> {
  const now = Date.now();
  let dbFailed = false;

  if (now >= dbUnavailableUntil) {
    try {
      // Opportunistically prune expired records in the background (roughly once every 50 calls)
      if (Math.random() < 0.02) {
        cleanupExpiredRateLimits().catch(() => {});
      }

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
      dbFailed = true;
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.error(
          `[RateLimit Critical Alert] Distributed PostgreSQL storage unreachable: ${err.message}. ${
            options?.failClosed ? "Failing closed on sensitive endpoint." : "Falling back to local instance memory."
          }`
        );
      }
    }
  } else {
    dbFailed = true;
  }

  // Sensitive endpoint policy: In production, fail closed if distributed DB is offline
  if (dbFailed && options?.failClosed && process.env.NODE_ENV === "production") {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 30,
    };
  }

  // Fallback: In-memory store (for testing, local dev, or non-critical endpoints)
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
 * Identifiers are cryptographically pseudonymized before database storage.
 */
export async function checkEmailCooldown(
  email: string,
  cooldownSeconds: number,
  options?: RateLimitOptions
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const normalized = email.toLowerCase().trim();
  const cooldownKey = pseudonymizeRateLimitKey("email_cooldown", normalized);
  const now = Date.now();
  let dbFailed = false;

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
      dbFailed = true;
      dbUnavailableUntil = Date.now() + 10_000;
      if (process.env.NODE_ENV === "production") {
        console.error(
          `[EmailCooldown Critical Alert] DB unavailable: ${err.message}. ${
            options?.failClosed ? "Failing closed." : "Falling back to local memory."
          }`
        );
      }
    }
  } else {
    dbFailed = true;
  }

  if (dbFailed && options?.failClosed && process.env.NODE_ENV === "production") {
    return {
      allowed: false,
      retryAfterSeconds: 30,
    };
  }

  // Fallback: In-memory store
  const expiresAt = emailCooldownStore.get(cooldownKey);
  if (expiresAt && expiresAt > now) {
    const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  emailCooldownStore.set(cooldownKey, now + cooldownSeconds * 1000);
  return { allowed: true };
}
